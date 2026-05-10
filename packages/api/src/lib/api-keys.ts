import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const PUBLIC_KEY_PREFIX = "zp_pub_";
export const SECRET_KEY_PREFIX = "sk_live_";

const PUBLIC_KEY_BYTES = 16;
const SECRET_KEY_BYTES = 24;

const PUBLIC_KEY_PATTERN = /^zp_pub_[0-9a-f]{32}$/;
const SECRET_KEY_PATTERN = /^sk_live_[0-9a-f]{48}$/;

export interface ApiKeyPair {
  /** Non-secret identifier safe to display. Format: `zp_pub_<32 hex>`. */
  public: string;
  /** Secret bearer token. Format: `sk_live_<48 hex>`. Shown to the merchant
   * exactly once at creation; the server only persists `sha256(secret)`. */
  secret: string;
}

/**
 * Mint a fresh ZettaPay API key pair. Both halves are derived from a CSPRNG;
 * the secret is never persisted in plaintext — callers must hash it via
 * {@link hashSecret} before writing to storage.
 */
export function generateKeyPair(): ApiKeyPair {
  const publicKey = `${PUBLIC_KEY_PREFIX}${randomBytes(PUBLIC_KEY_BYTES).toString("hex")}`;
  const secret = `${SECRET_KEY_PREFIX}${randomBytes(SECRET_KEY_BYTES).toString("hex")}`;
  return { public: publicKey, secret };
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function isPublicKey(value: string): boolean {
  return PUBLIC_KEY_PATTERN.test(value);
}

export function isSecretKey(value: string): boolean {
  return SECRET_KEY_PATTERN.test(value);
}

/** Constant-time comparison for two hex digests of equal length. */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}
