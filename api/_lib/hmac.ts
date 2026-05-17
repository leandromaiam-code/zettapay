// Webhook signing — HMAC-SHA256 over the raw JSON body. Merchants verify
// by recomputing the same HMAC with their per-merchant `webhook_secret`
// and comparing in constant time against the `X-ZettaPay-Signature` header.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const ZETTAPAY_SIGNATURE_HEADER = 'X-ZettaPay-Signature';

/** Hex-encoded HMAC-SHA256 of `body` with `secret`. */
export function signWebhook(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Constant-time signature check. Returns true iff `signature` (hex) matches
 * the HMAC-SHA256 of `body` with `secret`. Tolerates differing-length inputs
 * without leaking via timing.
 */
export function verifyWebhook(secret: string, body: string, signature: string): boolean {
  if (typeof signature !== 'string' || signature.length === 0) return false;
  const expected = signWebhook(secret, body);
  if (expected.length !== signature.length) return false;
  const expectedBuf = Buffer.from(expected, 'hex');
  let candidate: Buffer;
  try {
    candidate = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expectedBuf.length !== candidate.length) return false;
  return timingSafeEqual(expectedBuf, candidate);
}

/** 32-byte random secret, returned as `whsec_<hex>`. */
export function freshWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('hex')}`;
}
