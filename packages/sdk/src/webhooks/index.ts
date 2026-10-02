/**
 * `@zettapay/sdk/webhooks` — verifier for the webhooks the self-hosted
 * listener and ZettaPay Cloud actually send. Node-only (`node:crypto`); no
 * other dependencies.
 *
 * Wire format (identical for listener and Cloud):
 *   - body: flat JSON object with an `event` discriminator
 *   - `X-ZettaPay-Signature`: lowercase hex HMAC-SHA256 of the raw body, keyed
 *     by the merchant webhook secret (no prefix, timestamp NOT included)
 *   - `X-ZettaPay-Timestamp`: delivery time in epoch MILLISECONDS
 *   - `X-ZettaPay-Event-Id`: event id, reused across retries of the same event
 *   - `X-ZettaPay-Attempt`: 1-indexed attempt number
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const WEBHOOK_SIGNATURE_HEADER = 'X-ZettaPay-Signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'X-ZettaPay-Timestamp';
export const WEBHOOK_EVENT_ID_HEADER = 'X-ZettaPay-Event-Id';
export const WEBHOOK_ATTEMPT_HEADER = 'X-ZettaPay-Attempt';

/** Default allowed drift between `X-ZettaPay-Timestamp` and the local clock. */
export const DEFAULT_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

const HEX_RE = /^[0-9a-f]+$/i;

/** A payment for an invoice reached the required confirmations. */
export interface InvoiceConfirmedWebhook {
  event: 'invoice.confirmed';
  invoice_id: string;
  merchant_id: string;
  /** `btc` or `base`. */
  chain: string;
  /** `BTC`, `USDC` or `USDT`. */
  asset: string;
  /** Invoice amount: decimal BTC for `btc`, integer token base units (6 decimals) for stablecoins. */
  amount: string;
  /** Address that received the payment. */
  address: string;
  tx_hash: string | null;
  /** ISO-8601 confirmation time. */
  confirmed_at: string;
  /** BTC invoices: confirmations observed when the event was emitted. */
  confirmations?: number;
  /** Base xpub-mode invoices: token balance of the invoice address, in base units. */
  balance?: string;
  /** Base fixed-address invoices: transferred value, in base units. */
  value?: string;
  /** Base fixed-address invoices: ERC-20 contract of the received token. */
  token_address?: string;
  /** Base fixed-address invoices: `{ mode, ref, nonce, asset }` set by the listener. */
  metadata?: { mode?: string; ref?: string; nonce?: number; asset?: string; [k: string]: unknown };
}

/**
 * Fixed-address mode only: an inbound transfer matched no active invoice
 * (wrong amount, expired invoice). Never fulfil an order from this event —
 * it exists so the merchant can decide on a refund.
 */
export interface PaymentOrphanWebhook {
  event: 'payment.orphan';
  merchant_id: string;
  chain: string;
  asset: string;
  token_address: string;
  address: string;
  tx_hash: string;
  /** Transferred value, in token base units. */
  value: string;
  /** ISO-8601 detection time. */
  detected_at: string;
}

export type ZettaPayWebhookEvent = InvoiceConfirmedWebhook | PaymentOrphanWebhook;

/** Any header container: plain object, Node `IncomingHttpHeaders`, or a fetch `Headers`. */
export type WebhookHeaders =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export type WebhookVerificationErrorCode =
  | 'missing_signature'
  | 'malformed_signature'
  | 'signature_mismatch'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'invalid_payload';

export class WebhookVerificationError extends Error {
  readonly code: WebhookVerificationErrorCode;

  constructor(code: WebhookVerificationErrorCode, message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
    this.code = code;
  }
}

export interface VerifyWebhookInput {
  /**
   * The request body exactly as received — bytes or the undecoded string.
   * Re-serialising a parsed object changes the bytes and breaks the signature.
   */
  rawBody: string | Uint8Array;
  /** Request headers (lookup is case-insensitive). */
  headers: WebhookHeaders;
  /** The merchant webhook secret (`MERCHANT_WEBHOOK_SECRET` on the listener). */
  secret: string;
  /**
   * Maximum drift between the timestamp header and the local clock, in
   * milliseconds. Default 5 minutes. Pass `null` to skip the check.
   */
  toleranceMs?: number | null;
  /** Clock override for tests — returns epoch milliseconds. */
  now?: () => number;
}

export interface VerifiedWebhook {
  /** The decoded, signature-verified payload. */
  event: ZettaPayWebhookEvent;
  /** `X-ZettaPay-Event-Id` — use it as the idempotency key. `null` if the header is absent. */
  eventId: string | null;
  /** `X-ZettaPay-Attempt` (1-indexed). `null` if the header is absent or not a number. */
  attempt: number | null;
  /** `X-ZettaPay-Timestamp` in epoch milliseconds. */
  timestampMs: number;
}

/**
 * Hex HMAC-SHA256 of the raw body — exactly what the dispatcher puts in
 * `X-ZettaPay-Signature`. Useful for building test fixtures.
 */
export function computeWebhookSignature(rawBody: string | Uint8Array, secret: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

/**
 * Verify a webhook delivery from the listener or from ZettaPay Cloud and
 * return its payload. Throws `WebhookVerificationError` on any failure —
 * answer with a non-2xx status and the dispatcher will retry.
 *
 * The signature covers the body only. The timestamp header is not signed, so
 * the tolerance check rejects stale or misrouted deliveries but is not replay
 * protection on its own: de-duplicate on `eventId` before fulfilling an order.
 */
export function verifyWebhook(input: VerifyWebhookInput): VerifiedWebhook {
  if (typeof input.secret !== 'string' || input.secret === '') {
    throw new TypeError('verifyWebhook: secret is required');
  }

  const signature = readHeader(input.headers, WEBHOOK_SIGNATURE_HEADER);
  if (!signature) {
    throw new WebhookVerificationError('missing_signature', `missing ${WEBHOOK_SIGNATURE_HEADER} header`);
  }
  if (signature.length !== 64 || !HEX_RE.test(signature)) {
    throw new WebhookVerificationError(
      'malformed_signature',
      `${WEBHOOK_SIGNATURE_HEADER} must be a 64-character hex string`,
    );
  }

  const expected = createHmac('sha256', input.secret).update(input.rawBody).digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new WebhookVerificationError('signature_mismatch', 'signature does not match the raw body');
  }

  const timestampRaw = readHeader(input.headers, WEBHOOK_TIMESTAMP_HEADER);
  if (!timestampRaw) {
    throw new WebhookVerificationError('missing_timestamp', `missing ${WEBHOOK_TIMESTAMP_HEADER} header`);
  }
  const timestampMs = Number(timestampRaw);
  if (!/^\d+$/.test(timestampRaw) || !Number.isSafeInteger(timestampMs)) {
    throw new WebhookVerificationError(
      'invalid_timestamp',
      `${WEBHOOK_TIMESTAMP_HEADER} must be epoch milliseconds`,
    );
  }
  const tolerance = input.toleranceMs === undefined ? DEFAULT_WEBHOOK_TOLERANCE_MS : input.toleranceMs;
  if (tolerance !== null) {
    const now = input.now ? input.now() : Date.now();
    if (Math.abs(now - timestampMs) > tolerance) {
      throw new WebhookVerificationError(
        'timestamp_out_of_tolerance',
        `timestamp is more than ${tolerance}ms away from the local clock`,
      );
    }
  }

  const text =
    typeof input.rawBody === 'string' ? input.rawBody : Buffer.from(input.rawBody).toString('utf8');
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    throw new WebhookVerificationError('invalid_payload', 'body is not valid JSON');
  }
  if (
    typeof decoded !== 'object' ||
    decoded === null ||
    Array.isArray(decoded) ||
    typeof (decoded as { event?: unknown }).event !== 'string'
  ) {
    throw new WebhookVerificationError('invalid_payload', 'body is not an event object');
  }

  const attemptRaw = readHeader(input.headers, WEBHOOK_ATTEMPT_HEADER);
  const attempt = attemptRaw !== null && /^\d+$/.test(attemptRaw) ? Number(attemptRaw) : null;

  return {
    event: decoded as ZettaPayWebhookEvent,
    eventId: readHeader(input.headers, WEBHOOK_EVENT_ID_HEADER),
    attempt,
    timestampMs,
  };
}

function readHeader(headers: WebhookHeaders, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(n: string): string | null }).get(name);
    return value === null || value === undefined ? null : String(value).trim() || null;
  }
  const wanted = name.toLowerCase();
  const bag = headers as Record<string, string | string[] | undefined>;
  for (const key of Object.keys(bag)) {
    if (key.toLowerCase() !== wanted) continue;
    const raw = bag[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}
