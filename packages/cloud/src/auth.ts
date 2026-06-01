// Multi-tenant API-key auth. A raw key looks like `zp_live_<48 hex chars>` and
// is shown to the merchant exactly once (at seed time). Only its SHA-256 hash is
// persisted, alongside a short non-secret prefix for dashboard display. A lookup
// hashes the presented key and resolves it to a merchant_id, ignoring any key
// whose `revoked_at` is set.
//
// The sliding-window limiter mirrors @zettapay/listener's SlidingWindowRateLimiter
// (same algorithm, in-process Map, no Redis/telemetry) — re-implemented here only
// because the listener does not export it. Bucketing is per merchant_id so one
// tenant can never spend another tenant's budget.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CloudDb } from './cloud-db.js';

const KEY_PREFIX = 'zp_live_';

export interface GeneratedApiKey {
  /** Full secret — return to the merchant once, never stored. */
  key: string;
  /** SHA-256 hex of the full key — what we persist + look up by. */
  hash: string;
  /** Non-secret leading slice safe to display (e.g. "zp_live_a1b2c3d4"). */
  prefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${KEY_PREFIX}${randomBytes(24).toString('hex')}`;
  return { key, hash: hashApiKey(key), prefix: key.slice(0, KEY_PREFIX.length + 8) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key.trim()).digest('hex');
}

/** Constant-time compare of two equal-purpose hex digests. */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export interface AuthResult {
  ok: boolean;
  merchantId?: string;
}

/**
 * Resolve a presented API key to a merchant. Returns ok:false for a missing,
 * malformed, unknown, or revoked key — the caller turns that into a 401.
 */
export async function authenticate(db: CloudDb, presented: string | undefined): Promise<AuthResult> {
  const key = (presented ?? '').trim();
  if (!key.startsWith(KEY_PREFIX)) return { ok: false };
  const row = await db.findActiveApiKey(hashApiKey(key));
  if (!row) return { ok: false };
  // Defensive constant-time re-check against the stored hash.
  if (!safeEqualHex(row.api_key_hash, hashApiKey(key))) return { ok: false };
  return { ok: true, merchantId: row.merchant_id };
}

export interface RateLimitConfig {
  perKeyPerWindow: number;
  windowMs: number;
}

export const DEFAULT_CLOUD_RATE_LIMIT: RateLimitConfig = {
  perKeyPerWindow: 60,
  windowMs: 60_000,
};

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

export class CloudRateLimiter {
  private readonly cfg: RateLimitConfig;
  private readonly now: () => number;
  private readonly buckets = new Map<string, number[]>();

  constructor(cfg: RateLimitConfig = DEFAULT_CLOUD_RATE_LIMIT, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  hit(bucket: string): RateLimitDecision {
    const t = this.now();
    const cutoff = t - this.cfg.windowMs;
    const ring = (this.buckets.get(bucket) ?? []).filter((ts) => ts > cutoff);
    if (ring.length >= this.cfg.perKeyPerWindow) {
      this.buckets.set(bucket, ring);
      const oldest = ring[0] ?? t;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.cfg.windowMs - t) / 1000)) };
    }
    ring.push(t);
    this.buckets.set(bucket, ring);
    return { allowed: true };
  }
}
