// SlidingWindowRateLimiter — a dependency-free, in-process limiter for the
// listener's POST /invoice endpoint (Z76 FIX 3). Creating invoices allocates a
// scarce per-(chain,price) nonce; an unbounded caller could exhaust the nonce
// pool or flood storage. We bound creation with a sliding time window kept
// entirely in memory (Map ip -> recent timestamps) plus a global ceiling.
//
// Self-hosted / privacy preserving (HR-PHONE-HOME): no external service, no
// Redis, no telemetry — just a Map on the merchant's own box. Memory is bounded
// because every check prunes timestamps older than the window and drops empty
// buckets.

export interface RateLimitConfig {
  /** Max invoice creations per IP within the window. */
  perIpPerWindow: number;
  /** Max invoice creations across ALL IPs within the window. */
  globalPerWindow: number;
  /** Sliding window length in ms (default 60_000 = 1 minute). */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perIpPerWindow: 30,
  globalPerWindow: 300,
  windowMs: 60_000,
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Which ceiling tripped, when not allowed. */
  scope?: 'ip' | 'global';
  /** Seconds the caller should wait before retrying (for Retry-After). */
  retryAfterSeconds?: number;
}

/**
 * Parse ZETTAPAY_RATE_LIMIT. Accepted forms (whitespace ignored):
 *   "30"        -> perIp=30, global=default
 *   "30,300"    -> perIp=30, global=300
 *   "30/300"    -> same, slash separator
 *   "off"|"0"   -> disabled (returns null; caller skips limiting)
 * Invalid / partial input falls back to the matching default field, so a typo
 * can never crash boot.
 */
export function parseRateLimitEnv(
  raw: string | undefined,
  base: RateLimitConfig = DEFAULT_RATE_LIMIT,
): RateLimitConfig | null {
  if (raw === undefined) return base;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === '' ) return base;
  if (trimmed === 'off' || trimmed === 'disabled' || trimmed === '0') return null;
  const parts = trimmed.split(/[,/]/).map((p) => p.trim());
  const perIp = toPositiveInt(parts[0], base.perIpPerWindow);
  const global = toPositiveInt(parts[1], base.globalPerWindow);
  return {
    perIpPerWindow: perIp,
    globalPerWindow: Math.max(global, perIp),
    windowMs: base.windowMs,
  };
}

function toPositiveInt(s: string | undefined, fallback: number): number {
  if (s === undefined || s === '') return fallback;
  const n = Number.parseInt(s, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export class SlidingWindowRateLimiter {
  private readonly cfg: RateLimitConfig;
  private readonly now: () => number;
  /** Per-IP ring of recent hit timestamps (ms). */
  private readonly perIp = new Map<string, number[]>();
  /** Global ring of recent hit timestamps (ms). */
  private global: number[] = [];

  constructor(cfg: RateLimitConfig = DEFAULT_RATE_LIMIT, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
  }

  /**
   * Record one hit for `ip` and decide whether it is allowed. A rejected hit is
   * NOT counted toward the window (so a flood doesn't extend its own penalty).
   */
  hit(ip: string): RateLimitDecision {
    const t = this.now();
    const cutoff = t - this.cfg.windowMs;

    const globalRecent = prune(this.global, cutoff);
    this.global = globalRecent;
    if (globalRecent.length >= this.cfg.globalPerWindow) {
      return { allowed: false, scope: 'global', retryAfterSeconds: this.retryAfter(globalRecent, t) };
    }

    const bucket = prune(this.perIp.get(ip) ?? [], cutoff);
    if (bucket.length >= this.cfg.perIpPerWindow) {
      this.perIp.set(ip, bucket);
      return { allowed: false, scope: 'ip', retryAfterSeconds: this.retryAfter(bucket, t) };
    }

    bucket.push(t);
    globalRecent.push(t);
    this.perIp.set(ip, bucket);
    return { allowed: true };
  }

  /** Seconds until the oldest in-window hit ages out (>=1). */
  private retryAfter(ring: number[], t: number): number {
    const oldest = ring[0];
    if (oldest === undefined) return 1;
    const ms = oldest + this.cfg.windowMs - t;
    return Math.max(1, Math.ceil(ms / 1000));
  }

  /** Test/inspection helper — current in-window count for an IP. */
  countFor(ip: string): number {
    const cutoff = this.now() - this.cfg.windowMs;
    return prune(this.perIp.get(ip) ?? [], cutoff).length;
  }
}

/** Drop timestamps older than cutoff, returning the same array trimmed. */
function prune(ring: number[], cutoff: number): number[] {
  let i = 0;
  while (i < ring.length && ring[i]! <= cutoff) i += 1;
  return i > 0 ? ring.slice(i) : ring;
}
