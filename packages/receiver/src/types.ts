// Public-facing types for @zettapay/receiver. The shape of the webhook
// payload is intentionally loose (`unknown` for `data`) because the receiver
// is a developer test tool — it has to round-trip whatever the listener
// happens to POST today plus whatever lands in future schema additions
// without forcing a release here. We only assert the envelope keys that
// every ZettaPay webhook is guaranteed to have.

export interface WebhookEnvelope {
  /** Event type, e.g. `invoice.confirmed`, `invoice.expired`. */
  event?: string;
  /** Invoice id from the listener (`inv_*`). Present for invoice.* events. */
  invoice_id?: string;
  /** Chain enum from the protocol. */
  chain?: string;
  /** Free-form per-event payload. */
  data?: unknown;
  /** Top-level keys we don't model are passed through verbatim. */
  [key: string]: unknown;
}

export interface SignatureVerifyInput {
  /** Raw request body bytes — HMAC is computed over these, not the parsed JSON. */
  body: Buffer;
  /** Value of `X-ZettaPay-Signature` header (hex digest). */
  signatureHeader: string | undefined;
  /** Value of `X-ZettaPay-Timestamp` header (unix seconds OR milliseconds). */
  timestampHeader: string | undefined;
  /** Shared secret configured by the merchant on the listener side. */
  secret: string;
  /** Override `Date.now()` for deterministic tests. Returns unix MILLISECONDS. */
  now?: () => number;
  /** Reject timestamps older than this many seconds. Default 300 (5 min). */
  maxAgeSeconds?: number;
}

export type SignatureVerifyResult =
  | { ok: true; ageMs: number }
  | {
      ok: false;
      reason: 'missing_signature' | 'missing_timestamp' | 'bad_timestamp' | 'timestamp_too_old' | 'invalid_signature';
      ageMs?: number;
    };

export interface ServerStats {
  /** Wall-clock when the server started. */
  startedAt: Date;
  requestsTotal: number;
  requestsOk: number;
  requestsFailed: number;
}
