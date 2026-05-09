import type { RateLimitDecision, RateLimitStore } from "./rate-limit-store.js";

interface RedisCommandClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit?(): Promise<unknown>;
  disconnect?(): void;
}

const SLIDING_WINDOW_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
local cutoff = now - window

redis.call('ZREMRANGEBYSCORE', key, 0, cutoff)
local count = redis.call('ZCARD', key)
local allowed = 0
if count < max then
  redis.call('ZADD', key, now, now .. '-' .. math.random())
  count = count + 1
  allowed = 1
end
redis.call('PEXPIRE', key, window)
local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local reset_at = now + window
if oldest[2] then
  reset_at = tonumber(oldest[2]) + window
end
return { allowed, count, reset_at }
`;

export interface RedisRateLimitStoreOptions {
  client: RedisCommandClient;
  keyPrefix?: string;
  now?: () => number;
}

export class RedisRateLimitStore implements RateLimitStore {
  private readonly client: RedisCommandClient;
  private readonly prefix: string;
  private readonly now: () => number;

  constructor(options: RedisRateLimitStoreOptions) {
    this.client = options.client;
    this.prefix = options.keyPrefix ?? "ratelimit:";
    this.now = options.now ?? Date.now;
  }

  async hit(
    key: string,
    windowMs: number,
    max: number,
  ): Promise<RateLimitDecision> {
    const now = this.now();
    const result = (await this.client.eval(
      SLIDING_WINDOW_LUA,
      1,
      this.prefix + key,
      now,
      windowMs,
      max,
    )) as [number, number, number];

    const allowed = Number(result[0]) === 1;
    const count = Number(result[1]);
    const resetAtMs = Number(result[2]);
    return {
      allowed,
      count,
      remaining: allowed ? Math.max(0, max - count) : 0,
      limit: max,
      windowMs,
      resetAtMs,
    };
  }

  async close(): Promise<void> {
    if (this.client.quit) {
      try {
        await this.client.quit();
      } catch {
        this.client.disconnect?.();
      }
    } else {
      this.client.disconnect?.();
    }
  }
}

export async function createRedisRateLimitStore(
  url: string,
  options: { keyPrefix?: string; now?: () => number } = {},
): Promise<RedisRateLimitStore> {
  const mod = (await import("ioredis")) as unknown as {
    default: new (url: string) => RedisCommandClient;
  };
  const Redis = mod.default;
  const client = new Redis(url);
  return new RedisRateLimitStore({ client, ...options });
}
