import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'X-ZettaPay-Signature';
export const TIMESTAMP_HEADER = 'X-ZettaPay-Timestamp';
export const EVENT_ID_HEADER = 'X-ZettaPay-Event-Id';
export const ATTEMPT_HEADER = 'X-ZettaPay-Attempt';

const SIGNATURE_PREFIX = 'sha256=';
const HEX_RE = /^[0-9a-f]+$/i;
const DEFAULT_TOLERANCE_SEC = 300;

export type WebhookFailureReason =
  | 'missing_event_id'
  | 'missing_signature'
  | 'malformed_signature'
  | 'missing_timestamp'
  | 'invalid_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'signature_mismatch'
  | 'invalid_payload';

export type HeaderBag =
  | Record<string, string | string[] | undefined>
  | { get(name: string): string | null };

export interface ParseWebhookOptions<TPayload = unknown> {
  /** Merchant webhook secret. Must match the secret stored on the merchant record. */
  secret: string;
  /** Raw request body — `Buffer`, `Uint8Array`, or pre-decoded `string`. JSON re-encoding breaks the HMAC. */
  body: Buffer | Uint8Array | string;
  /** Headers from the inbound request. Accepts plain objects, Node `IncomingHttpHeaders`, or `Headers`. */
  headers: HeaderBag;
  /** Reject events whose timestamp drifts more than this many seconds from `now`. Defaults to 300s. */
  toleranceSec?: number;
  /** Override the clock for tests. */
  now?: () => number;
  /** Optional payload validator/parser. Receives the JSON-decoded body and may narrow the type. */
  parsePayload?: (raw: unknown) => TPayload;
}

export interface ParsedWebhook<TPayload = unknown> {
  /** Stable across retries — use this as your idempotency dedup key. */
  eventId: string;
  /** Epoch milliseconds emitted by the dispatcher (`X-ZettaPay-Timestamp`). */
  timestamp: number;
  /** 1-indexed attempt number from `X-ZettaPay-Attempt`. `null` if header is absent. */
  attempt: number | null;
  /** JSON-decoded body, optionally narrowed by `parsePayload`. */
  payload: TPayload;
  /** Verbatim raw body as a UTF-8 string. */
  rawBody: string;
}

export type ParseWebhookResult<TPayload = unknown> =
  | { valid: true; event: ParsedWebhook<TPayload> }
  | { valid: false; reason: WebhookFailureReason };

/**
 * Verifies a ZettaPay webhook (HMAC + timestamp drift) and extracts the dedup
 * key in one call. Returns `{ valid: true, event }` with the stable
 * `event.eventId` from `X-ZettaPay-Event-Id` so a merchant can dedupe before
 * processing — retries reuse the same id.
 *
 * Pass the *raw* request body (e.g. via `express.raw()`); re-serializing JSON
 * changes byte order and invalidates the signature.
 */
export function parseWebhook<TPayload = unknown>(
  opts: ParseWebhookOptions<TPayload>,
): ParseWebhookResult<TPayload> {
  const eventId = readHeader(opts.headers, EVENT_ID_HEADER);
  if (!eventId) return { valid: false, reason: 'missing_event_id' };

  const signature = readHeader(opts.headers, SIGNATURE_HEADER);
  if (!signature) return { valid: false, reason: 'missing_signature' };

  const timestampRaw = readHeader(opts.headers, TIMESTAMP_HEADER);
  if (!timestampRaw) return { valid: false, reason: 'missing_timestamp' };

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.now ? opts.now() : Date.now();
  if (Math.abs(now - timestamp) > tolerance * 1000) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const provided = parseSignature(signature);
  if (!provided) return { valid: false, reason: 'malformed_signature' };

  const rawBody = bodyToString(opts.body);
  const expected = createHmac('sha256', opts.secret)
    .update(`${timestampRaw}.${rawBody}`)
    .digest('hex');

  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  let decoded: unknown;
  try {
    decoded = rawBody.length === 0 ? null : JSON.parse(rawBody);
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  let payload: TPayload;
  try {
    payload = opts.parsePayload ? opts.parsePayload(decoded) : (decoded as TPayload);
  } catch {
    return { valid: false, reason: 'invalid_payload' };
  }

  const attemptHeader = readHeader(opts.headers, ATTEMPT_HEADER);
  const attempt = attemptHeader === null ? null : Number(attemptHeader);

  return {
    valid: true,
    event: {
      eventId,
      timestamp,
      attempt: attempt !== null && Number.isFinite(attempt) ? attempt : null,
      payload,
      rawBody,
    },
  };
}

/**
 * Tiny store contract used by `dedupe()`. Plug in Redis, Postgres, or any
 * backing store that implements these two methods. Operations are expected to
 * be atomic per-eventId; treat repeated calls as idempotent.
 */
export interface EventStore {
  has(eventId: string): boolean | Promise<boolean>;
  add(eventId: string): void | Promise<void>;
}

/**
 * In-memory `EventStore` for development, tests, and single-process workers.
 * Holds a bounded set of recent event ids — not safe for multi-instance
 * deployments, but useful for local fixtures and small workers.
 *
 * Eviction is FIFO once `maxEntries` is reached.
 */
export class MemoryEventStore implements EventStore {
  private readonly maxEntries: number;
  private readonly seen = new Set<string>();

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
  }

  has(eventId: string): boolean {
    return this.seen.has(eventId);
  }

  add(eventId: string): void {
    if (this.seen.has(eventId)) return;
    if (this.seen.size >= this.maxEntries) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.seen.add(eventId);
  }

  /** Test/operational helper — clears the entire dedup window. */
  clear(): void {
    this.seen.clear();
  }

  /** Number of event ids currently retained. */
  get size(): number {
    return this.seen.size;
  }
}

export interface DedupeResult {
  /** `true` if the eventId had not been seen before this call. */
  fresh: boolean;
  /** `true` if the eventId was already in the store — the merchant should ack 200 and skip work. */
  duplicate: boolean;
}

/**
 * Atomically check-and-record an eventId in the given `EventStore`. Returns
 * `{ duplicate: true }` if the event has already been processed so the
 * merchant can short-circuit with a 200 OK response.
 */
export async function dedupe(eventId: string, store: EventStore): Promise<DedupeResult> {
  const seen = await store.has(eventId);
  if (seen) return { fresh: false, duplicate: true };
  await store.add(eventId);
  return { fresh: true, duplicate: false };
}

function readHeader(headers: HeaderBag, name: string): string | null {
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get(name: string): string | null }).get(name);
    return value && value.length > 0 ? value : null;
  }
  const bag = headers as Record<string, string | string[] | undefined>;
  const lower = name.toLowerCase();
  const direct = bag[name] ?? bag[lower];
  if (direct === undefined) return null;
  const value = Array.isArray(direct) ? direct[0] : direct;
  return value && value.length > 0 ? value : null;
}

function parseSignature(raw: string): string | null {
  const trimmed = raw.trim();
  const value = trimmed.startsWith(SIGNATURE_PREFIX)
    ? trimmed.slice(SIGNATURE_PREFIX.length)
    : trimmed;
  if (value.length === 0 || value.length % 2 !== 0) return null;
  if (!HEX_RE.test(value)) return null;
  return value.toLowerCase();
}

function bodyToString(body: Buffer | Uint8Array | string): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  return Buffer.from(body).toString('utf8');
}
