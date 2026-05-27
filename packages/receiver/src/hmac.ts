// HMAC-SHA256 verification helpers, kept tiny and dependency-free so the
// package install footprint stays under a hundred files.
//
// Signature contract (mirrors @zettapay/listener WebhookDispatcher):
//   X-ZettaPay-Signature: hex(HMAC_SHA256(secret, body))
//   X-ZettaPay-Timestamp: unix epoch (seconds OR milliseconds — auto-detect)
//
// Replay protection: timestamps older than `maxAgeSeconds` are rejected even
// if the signature is valid. Default 300s matches Stripe's recommendation.
//
// Comparisons use `crypto.timingSafeEqual` against equal-length Buffers so a
// byte-by-byte timing attack against `===` cannot leak the secret.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SignatureVerifyInput, SignatureVerifyResult } from './types.js';

const DEFAULT_MAX_AGE_SECONDS = 300;

/**
 * Compute the canonical HMAC-SHA256 hex digest for a body + secret. Exposed
 * separately so tests + the CLI's `--simulate` path can craft a valid
 * signature without reimplementing the formula.
 */
export function computeSignature(secret: string, body: Buffer | string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Verify an incoming webhook against its signature + timestamp headers.
 *
 * Returns a discriminated result so callers can log + respond with the
 * specific failure mode (Stripe returns `400` for missing/bad headers and
 * `401` for signature mismatch — we differentiate here, the HTTP server
 * decides the status code).
 */
export function verifySignature(input: SignatureVerifyInput): SignatureVerifyResult {
  const { body, signatureHeader, timestampHeader, secret } = input;
  const now = (input.now ?? Date.now)();
  const maxAgeMs = (input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS) * 1000;

  if (!signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!timestampHeader) return { ok: false, reason: 'missing_timestamp' };

  const tsMs = parseTimestampMs(timestampHeader);
  if (tsMs == null) return { ok: false, reason: 'bad_timestamp' };

  const ageMs = now - tsMs;
  // Reject if timestamp is too far in the past. A small negative skew
  // (clock ahead by < 2 min) is tolerated rather than producing a confusing
  // "bad_timestamp"; the test merchant + receiver wall clocks won't always
  // tick in lockstep.
  if (ageMs > maxAgeMs) return { ok: false, reason: 'timestamp_too_old', ageMs };
  if (ageMs < -2 * 60_000) return { ok: false, reason: 'bad_timestamp' };

  const expected = computeSignature(secret, body);
  if (!timingSafeEqualHex(expected, signatureHeader.trim().toLowerCase())) {
    return { ok: false, reason: 'invalid_signature', ageMs };
  }
  return { ok: true, ageMs };
}

/**
 * Parse `X-ZettaPay-Timestamp` accepting either seconds (10 digits) or
 * milliseconds (13 digits). The listener historically sends ms; CLI testers
 * usually pipe `date +%s` (seconds) — we accept both rather than force one.
 */
function parseTimestampMs(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return null;
  // Heuristic: < 10^12 → seconds, else milliseconds. 10^12 ms ≈ year 2001;
  // any timestamp emitted post-2001 in seconds is < 10^11.
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

/**
 * Constant-time compare of two same-length hex strings. Falls back to a
 * (still constant-time-ish) boolean accumulator if the lengths differ, so
 * an attacker can't learn the digest length from a "wrong length" early
 * exit.
 */
function timingSafeEqualHex(a: string, b: string): boolean {
  // Normalize both to lowercase; HMAC output is canonical lowercase, but
  // some testers paste uppercase signatures from openssl on macOS.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Length mismatch — compare against a same-length buffer of zeros so we
    // burn the same compare cost as the happy path, then return false.
    const filler = Buffer.alloc(aBuf.length);
    timingSafeEqual(aBuf, filler);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
