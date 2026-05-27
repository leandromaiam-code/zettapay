import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseEvent } from './events.js';
import type { ZettaPayEvent } from './types.js';

const DEFAULT_TOLERANCE_SECONDS = 300;
const SIGNATURE_PREFIX = 'sha256=';
const HEX_RE = /^[0-9a-f]+$/i;

export type WebhookSignatureErrorCode =
  | 'invalid_signature'
  | 'timestamp_too_old'
  | 'malformed';

/**
 * Thrown by `verifyWebhookSignature` when the request fails any of the
 * checks. The `code` field is a stable enum a merchant can branch on.
 */
export class WebhookSignatureError extends Error {
  readonly code: WebhookSignatureErrorCode;

  constructor(code: WebhookSignatureErrorCode, message: string) {
    super(message);
    this.name = 'WebhookSignatureError';
    this.code = code;
  }
}

export interface VerifyWebhookOptions {
  /**
   * Maximum drift (in seconds) between the timestamp header and `now`.
   * Defaults to 300 (5 minutes), matching Stripe.
   */
  toleranceSeconds?: number;
  /**
   * Inject a clock for tests. Returns epoch seconds.
   */
  now?: () => number;
}

/**
 * Verify a ZettaPay webhook delivery and return the parsed event.
 *
 * Runs four checks, in order, before returning a typed event:
 *
 * 1. The `timestamp` header parses to a finite number of epoch seconds.
 * 2. `|now - timestamp|` is within `toleranceSeconds` (default 300s) —
 *    replay protection.
 * 3. The HMAC-SHA256 of `${timestamp}.${payload}` keyed by `secret` matches
 *    the `signature` header (`sha256=` prefix accepted but optional), using
 *    constant-time comparison.
 * 4. The decoded payload validates against the `ZettaPayEvent` schema.
 *
 * On failure throws `WebhookSignatureError` with a stable `code`. Reply 401
 * to the listener — it will retry with exponential backoff.
 *
 * Pass the *raw* request body. JSON re-encoding changes byte order and
 * invalidates the signature.
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  timestamp: string,
  secret: string,
  opts: VerifyWebhookOptions = {},
): ZettaPayEvent {
  const tolerance = opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || String(ts) !== timestamp.trim()) {
    throw new WebhookSignatureError('malformed', 'invalid timestamp header');
  }

  const nowSec = opts.now ? opts.now() : Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > tolerance) {
    throw new WebhookSignatureError(
      'timestamp_too_old',
      `timestamp outside ${tolerance}s tolerance`,
    );
  }

  const provided = stripSignaturePrefix(signature);
  if (!provided || provided.length % 2 !== 0 || !HEX_RE.test(provided)) {
    throw new WebhookSignatureError('malformed', 'malformed signature header');
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');

  const sigBuf = Buffer.from(provided, 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
    throw new WebhookSignatureError('invalid_signature', 'signature mismatch');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(payload);
  } catch {
    throw new WebhookSignatureError('malformed', 'payload is not valid JSON');
  }

  try {
    return parseEvent(decoded);
  } catch (err) {
    throw new WebhookSignatureError(
      'malformed',
      `payload does not match ZettaPayEvent schema: ${(err as Error).message}`,
    );
  }
}

function stripSignaturePrefix(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.startsWith(SIGNATURE_PREFIX)
    ? trimmed.slice(SIGNATURE_PREFIX.length)
    : trimmed;
}
