import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNATURE_HEADER = "X-ZettaPay-Signature";
export const TIMESTAMP_HEADER = "X-ZettaPay-Timestamp";
export const EVENT_ID_HEADER = "X-ZettaPay-Event-Id";

const SIGNATURE_PREFIX = "sha256=";
const HEX_RE = /^[0-9a-f]+$/i;

export interface SignWebhookOptions {
  secret: string;
  payload: string;
  timestamp: string | number;
}

export interface VerifyWebhookOptions {
  secret: string;
  payload: string;
  timestamp: string | number;
  signature: string;
  /**
   * Reject signatures whose timestamp drifts more than this many seconds from
   * `now`. Defaults to 5 minutes — Stripe's webhook tolerance.
   */
  toleranceSec?: number;
  now?: () => number;
}

export type VerifyFailureReason =
  | "missing_signature"
  | "malformed_signature"
  | "missing_timestamp"
  | "invalid_timestamp"
  | "timestamp_out_of_tolerance"
  | "signature_mismatch";

export type VerifyResult =
  | { valid: true }
  | { valid: false; reason: VerifyFailureReason };

const DEFAULT_TOLERANCE_SEC = 300;

export function signWebhookPayload(opts: SignWebhookOptions): string {
  const ts = String(opts.timestamp);
  const digest = createHmac("sha256", opts.secret)
    .update(`${ts}.${opts.payload}`)
    .digest("hex");
  return `${SIGNATURE_PREFIX}${digest}`;
}

export function verifyWebhookSignature(opts: VerifyWebhookOptions): VerifyResult {
  if (!opts.signature) return { valid: false, reason: "missing_signature" };
  if (opts.timestamp === undefined || opts.timestamp === null || opts.timestamp === "") {
    return { valid: false, reason: "missing_timestamp" };
  }

  const tsNumber = Number(opts.timestamp);
  if (!Number.isFinite(tsNumber)) {
    return { valid: false, reason: "invalid_timestamp" };
  }

  const tolerance = opts.toleranceSec ?? DEFAULT_TOLERANCE_SEC;
  const now = opts.now ? opts.now() : Date.now();
  if (Math.abs(now - tsNumber) > tolerance * 1000) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const provided = parseSignature(opts.signature);
  if (!provided) return { valid: false, reason: "malformed_signature" };

  const expected = createHmac("sha256", opts.secret)
    .update(`${String(opts.timestamp)}.${opts.payload}`)
    .digest("hex");

  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(provided, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "signature_mismatch" };
  }
  return { valid: true };
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
