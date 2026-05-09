import { HttpError } from "../lib/errors.js";
import { logger as defaultLogger, type Logger } from "../lib/logger.js";
import { retryWithBackoff } from "../lib/retry.js";

/**
 * USDC/USD price feed ID on Pyth (mainnet, stable). Hermes accepts the
 * 0x-prefixed hex; the same identifier resolves the on-chain price account
 * on both Pythnet and Solana mainnet.
 */
export const PYTH_USDC_USD_FEED_ID =
  "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a";

const DEFAULT_PYTH_HERMES_URL = "https://hermes.pyth.network";
const DEFAULT_COINGECKO_URL = "https://api.coingecko.com";
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_RETRIES = 2;

/**
 * Pyth confidence threshold. The oracle publishes a "conf" interval; if it
 * drifts beyond ±2% of the price we treat the feed as untrustworthy and
 * fall through to Coingecko rather than quote a stale or skewed rate.
 */
const PYTH_MAX_CONF_RATIO = 0.02;

export type PriceSource = "pyth" | "coingecko" | "cache";

export interface PriceQuote {
  /** USDC → USD rate. ~1.0 in normal market conditions. */
  rate: number;
  /** Which upstream produced the live quote (or `cache` on cache hit). */
  source: PriceSource;
  /** Wall-clock timestamp the rate was fetched (or originally fetched, on cache hit). */
  fetchedAt: number;
  /** Timestamp the cache entry expires (or expired, on a forced refresh). */
  expiresAt: number;
  /** Pyth-only: oracle publish time (epoch seconds). null when sourced from Coingecko. */
  publishTime?: number | null;
}

export interface PricingServiceOptions {
  pythHermesUrl?: string;
  coingeckoUrl?: string;
  cacheTtlMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
}

interface CachedQuote {
  rate: number;
  source: Exclude<PriceSource, "cache">;
  fetchedAt: number;
  expiresAt: number;
  publishTime: number | null;
}

/**
 * Fetches the USDC/USD spot rate.
 *
 * Order of operations:
 *   1. In-memory cache (60s TTL by default). Cache hits never touch the network.
 *   2. Pyth Hermes — relays the on-chain Pyth oracle price account. Validated
 *      against a confidence-interval guard so a depegged or stale feed isn't
 *      blindly served.
 *   3. Coingecko `simple/price` as a last-resort fallback.
 *
 * Failure semantics: if every upstream fails *and* the cache is empty the
 * caller gets an upstream HttpError. If the cache holds a recently-expired
 * entry, callers can opt into stale-while-error via {@link getRate}'s
 * `allowStale` flag.
 */
export class PricingService {
  private readonly hermesUrl: string;
  private readonly coingeckoUrl: string;
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly now: () => number;

  private cached: CachedQuote | null = null;
  private inflight: Promise<CachedQuote> | null = null;

  constructor(options: PricingServiceOptions = {}) {
    this.hermesUrl = stripTrailingSlash(
      options.pythHermesUrl ?? DEFAULT_PYTH_HERMES_URL,
    );
    this.coingeckoUrl = stripTrailingSlash(
      options.coingeckoUrl ?? DEFAULT_COINGECKO_URL,
    );
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.log = (options.logger ?? defaultLogger).child({ component: "pricing" });
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Returns the latest USDC/USD quote, reusing the cache when fresh.
   *
   * @param allowStale  When true, an expired cache entry is returned if every
   *                    live upstream fails — useful for surfaces that prefer
   *                    a stale rate over a hard error.
   */
  async getRate({ allowStale = false }: { allowStale?: boolean } = {}): Promise<PriceQuote> {
    const fresh = this.readCache();
    if (fresh) return fresh;

    if (this.inflight) {
      const result = await this.inflight;
      return this.toQuote(result, "cache");
    }

    this.inflight = this.refresh();
    try {
      const result = await this.inflight;
      return this.toQuote(result, result.source);
    } catch (err) {
      if (allowStale && this.cached) {
        this.log.warn("pricing.upstream_failed_stale_served", {
          error: err instanceof Error ? err.message : String(err),
          cachedAgeMs: this.now() - this.cached.fetchedAt,
        });
        return this.toQuote(this.cached, "cache");
      }
      throw err;
    } finally {
      this.inflight = null;
    }
  }

  /** Drops the cache. Tests use this; production callers shouldn't need to. */
  invalidate(): void {
    this.cached = null;
  }

  private readCache(): PriceQuote | null {
    if (!this.cached) return null;
    if (this.cached.expiresAt <= this.now()) return null;
    return this.toQuote(this.cached, "cache");
  }

  private toQuote(
    entry: CachedQuote,
    source: PriceSource,
  ): PriceQuote {
    return {
      rate: entry.rate,
      source,
      fetchedAt: entry.fetchedAt,
      expiresAt: entry.expiresAt,
      publishTime: entry.publishTime,
    };
  }

  private async refresh(): Promise<CachedQuote> {
    const errors: Error[] = [];
    try {
      const quote = await this.fetchFromPyth();
      this.cached = quote;
      return quote;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log.warn("pricing.pyth_failed", { error: e.message });
      errors.push(e);
    }

    try {
      const quote = await this.fetchFromCoingecko();
      this.cached = quote;
      return quote;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      this.log.error("pricing.coingecko_failed", { error: e.message });
      errors.push(e);
    }

    throw HttpError.upstream("Failed to fetch USDC/USD rate from any source", {
      errors: errors.map((e) => e.message),
    });
  }

  private async fetchFromPyth(): Promise<CachedQuote> {
    const url = `${this.hermesUrl}/v2/updates/price/latest?ids[]=${PYTH_USDC_USD_FEED_ID}`;
    const json = await this.fetchJson(url, "pyth");
    const parsed = extractPythPrice(json);
    const fetchedAt = this.now();
    return {
      rate: parsed.rate,
      source: "pyth",
      fetchedAt,
      expiresAt: fetchedAt + this.cacheTtlMs,
      publishTime: parsed.publishTime,
    };
  }

  private async fetchFromCoingecko(): Promise<CachedQuote> {
    const url = `${this.coingeckoUrl}/api/v3/simple/price?ids=usd-coin&vs_currencies=usd`;
    const json = await this.fetchJson(url, "coingecko");
    const rate = extractCoingeckoRate(json);
    const fetchedAt = this.now();
    return {
      rate,
      source: "coingecko",
      fetchedAt,
      expiresAt: fetchedAt + this.cacheTtlMs,
      publishTime: null,
    };
  }

  private async fetchJson(url: string, label: string): Promise<unknown> {
    return retryWithBackoff(
      async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
          const res = await this.fetchImpl(url, {
            method: "GET",
            headers: { accept: "application/json" },
            signal: controller.signal,
          });
          if (!res.ok) {
            throw new Error(`${label} HTTP ${res.status}`);
          }
          return (await res.json()) as unknown;
        } finally {
          clearTimeout(timer);
        }
      },
      {
        maxRetries: this.maxRetries,
        initialBackoffMs: 200,
        maxBackoffMs: 1_500,
      },
    );
  }
}

interface ParsedPythPrice {
  rate: number;
  publishTime: number;
}

/**
 * Hermes `/v2/updates/price/latest` returns
 * `{ parsed: [{ id, price: { price, conf, expo, publish_time } }] }`.
 * We compute `rate = price * 10^expo` and reject results whose confidence
 * interval drifts more than ±2% from the price (likely degenerate feed).
 */
export function extractPythPrice(json: unknown): ParsedPythPrice {
  if (!isRecord(json)) {
    throw new Error("pyth: response is not an object");
  }
  const parsed = json.parsed;
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("pyth: missing parsed[] entries");
  }
  const entry = parsed[0];
  if (!isRecord(entry) || !isRecord(entry.price)) {
    throw new Error("pyth: missing price object");
  }
  const priceStr = entry.price.price;
  const confStr = entry.price.conf;
  const expo = entry.price.expo;
  const publishTime = entry.price.publish_time;
  if (
    typeof priceStr !== "string" ||
    typeof confStr !== "string" ||
    typeof expo !== "number" ||
    typeof publishTime !== "number"
  ) {
    throw new Error("pyth: malformed price fields");
  }
  const priceN = Number(priceStr);
  const confN = Number(confStr);
  if (!Number.isFinite(priceN) || !Number.isFinite(confN) || priceN <= 0) {
    throw new Error("pyth: non-positive or non-finite price");
  }
  const scale = Math.pow(10, expo);
  const rate = priceN * scale;
  const conf = confN * scale;
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error("pyth: scaled rate non-positive");
  }
  if (conf / rate > PYTH_MAX_CONF_RATIO) {
    throw new Error(
      `pyth: confidence interval ${(conf / rate).toFixed(4)} exceeds ${PYTH_MAX_CONF_RATIO}`,
    );
  }
  return { rate, publishTime };
}

/**
 * Coingecko returns `{ "usd-coin": { "usd": 0.999985 } }`.
 */
export function extractCoingeckoRate(json: unknown): number {
  if (!isRecord(json)) {
    throw new Error("coingecko: response is not an object");
  }
  const usdCoin = json["usd-coin"];
  if (!isRecord(usdCoin)) {
    throw new Error("coingecko: missing usd-coin entry");
  }
  const usd = usdCoin.usd;
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) {
    throw new Error("coingecko: non-positive or non-finite usd value");
  }
  return usd;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}
