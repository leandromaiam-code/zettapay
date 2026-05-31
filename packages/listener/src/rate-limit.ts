// In-memory sliding-window rate limiter for POST /invoice (Z76, FIX 3). Guards
// against an abusive caller exhausting the fixed-address nonce pool or flooding
// invoice creation. Zero dependencies, zero network, zero shared state — it is
// a plain Map of recent timestamps living in the listener process, so it stays
// fully self-hosted (HR-PHONE-HOME) and adds no external service.
//
// Two windows are enforced simultaneously over a rolling 60s:
//   - per-IP   (default 30/min) — one abusive client cannot starve the others
//   - global   (default 300/min) — a bounded ceiling for the whole instance
//
// Both are configurable via the ZETTAPAY_RATE_LIMIT env var ("<perIp>,<global>"
// or just "<perIp>"). A value of 0 on either axis disables that axis.

export interface RateLimitConfig {
  /** Max invoice creations per IP per window. 0 disables the per-IP axis. */
  perIpPerMin: number;
  /** Max invoice creations across all IPs per window. 0 disables the axis. */
  globalPerMin: number;
  /** Rolling window length in ms. Defaults to 60_000. */
  windowMs?: number;
}

export const DEFAULT_RATE_LIMIT: Required<RateLimitConfig> = {
  perIpPerMin: 30,
  globalPerMin: 300,
  windowMs: 60_000,
};

export interface RateLimitDecision {
  ok: boolean;
  /** Which axis tripped, when ok === false. */
  scope?: 'ip' | 'global';
}

/**
 * Parse ZETTAPAY_RATE_LIMIT into a config, falling back to the defaults for any
 * field that is missing or malformed. Accepts "30", "30,300", or "30, 300".
 */
export function parseRateLimitEnv(raw: string | undefined): RateLimitConfig {
  if (!raw || !raw.trim()) return { ...DEFAULT_RATE_LIMIT };
  const parts = raw.split(',').map((s) => Number.parseInt(s.trim(), 10));
  const perIp =
    Number.isFinite(parts[0]!) && parts[0]! >= 0 ? parts[0]! : DEFAULT_RATE_LIMIT.perIpPerMin;
  const global =
    parts.length > 1 && Number.isFinite(parts[1]!) && parts[1]! >= 0
      ? parts[1]!
      : DEFAULT_RATE_LIMIT.globalPerMin;
  return { perIpPerMin: perIp, globalPerMin: global, windowMs: DEFAULT_RATE_LIMIT.windowMs };
}

export class SlidingWindowRateLimiter {
  private readonly perIpLimit: number;
  private readonly globalLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly perIp = new Map<string, number[]>();
  private global: number[] = [];

  constructor(config: Partial<RateLimitConfig> = {}, now: () => number = Date.now) {
    this.perIpLimit = config.perIpPerMin ?? DEFAULT_RATE_LIMIT.perIpPerMin;
    this.globalLimit = config.globalPerMin ?? DEFAULT_RATE_LIMIT.globalPerMin;
    this.windowMs = config.windowMs ?? DEFAULT_RATE_LIMIT.windowMs;
    this.now = now;
  }

  /**
   * Record a hit for `ip` and decide whether it is allowed. Prunes expired
   * timestamps on every call so memory stays bounded by the active window.
   */
  check(ip: string): RateLimitDecision {
    const t = this.now();
    const cutoff = t - this.windowMs;

    this.global = prune(this.global, cutoff);
    const ipHits = prune(this.perIp.get(ip) ?? [], cutoff);

    if (this.globalLimit > 0 && this.global.length >= this.globalLimit) {
      if (ipHits.length > 0) this.perIp.set(ip, ipHits);
      return { ok: false, scope: 'global' };
    }
    if (this.perIpLimit > 0 && ipHits.length >= this.perIpLimit) {
      this.perIp.set(ip, ipHits);
      return { ok: false, scope: 'ip' };
    }

    ipHits.push(t);
    this.global.push(t);
    this.perIp.set(ip, ipHits);
    return { ok: true };
  }
}

function prune(timestamps: number[], cutoff: number): number[] {
  // Timestamps are appended in non-decreasing order, so the live window is a
  // suffix — find the first index still inside the window and slice once.
  let i = 0;
  while (i < timestamps.length && timestamps[i]! <= cutoff) i += 1;
  return i === 0 ? timestamps : timestamps.slice(i);
}
