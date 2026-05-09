export interface RateLimitDecision {
  allowed: boolean;
  count: number;
  remaining: number;
  limit: number;
  windowMs: number;
  resetAtMs: number;
}

export interface RateLimitStore {
  hit(key: string, windowMs: number, max: number): Promise<RateLimitDecision>;
  close?(): Promise<void>;
}

interface MemoryStoreOptions {
  now?: () => number;
  gcIntervalMs?: number;
  maxKeys?: number;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(options: MemoryStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 100_000;
    const interval = options.gcIntervalMs;
    if (interval && interval > 0) {
      this.gcTimer = setInterval(() => this.collect(), interval);
      this.gcTimer.unref?.();
    }
  }

  async hit(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitDecision> {
    const now = this.now();
    const cutoff = now - windowMs;
    const existing = this.buckets.get(key) ?? [];
    const fresh: number[] = [];
    for (const ts of existing) {
      if (ts > cutoff) fresh.push(ts);
    }

    if (fresh.length >= max) {
      this.buckets.set(key, fresh);
      const oldest = fresh[0] ?? now;
      return {
        allowed: false,
        count: fresh.length,
        remaining: 0,
        limit: max,
        windowMs,
        resetAtMs: oldest + windowMs,
      };
    }

    fresh.push(now);
    this.buckets.set(key, fresh);
    if (this.buckets.size > this.maxKeys) this.collect();

    const oldest = fresh[0] ?? now;
    return {
      allowed: true,
      count: fresh.length,
      remaining: Math.max(0, max - fresh.length),
      limit: max,
      windowMs,
      resetAtMs: oldest + windowMs,
    };
  }

  async close(): Promise<void> {
    if (this.gcTimer) {
      clearInterval(this.gcTimer);
      this.gcTimer = null;
    }
    this.buckets.clear();
  }

  private collect(): void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) {
      const fresh = bucket.filter((ts) => ts > now - 60_000);
      if (fresh.length === 0) this.buckets.delete(key);
      else if (fresh.length !== bucket.length) this.buckets.set(key, fresh);
    }
  }
}
