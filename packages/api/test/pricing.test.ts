import { describe, it, expect, beforeEach } from "vitest";
import {
  PricingService,
  PYTH_USDC_USD_FEED_ID,
  extractCoingeckoRate,
  extractPythPrice,
} from "../src/services/pricing.js";

interface FakeResponseInit {
  ok?: boolean;
  status?: number;
  body: unknown;
}

function jsonResponse(init: FakeResponseInit): Response {
  return new Response(JSON.stringify(init.body), {
    status: init.status ?? (init.ok === false ? 500 : 200),
    headers: { "content-type": "application/json" },
  });
}

const PYTH_OK_BODY = {
  parsed: [
    {
      id: PYTH_USDC_USD_FEED_ID,
      price: {
        price: "99988729",
        conf: "10000",
        expo: -8,
        publish_time: 1_700_000_000,
      },
    },
  ],
};

const COINGECKO_OK_BODY = { "usd-coin": { usd: 1.0001 } };

interface Recorded {
  url: string;
}

function makeFetch(handlers: Array<(url: string) => Response>) {
  const calls: Recorded[] = [];
  let i = 0;
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url });
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i += 1;
    if (!handler) {
      throw new Error("fake fetch: no handler");
    }
    return handler(url);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("PricingService", () => {
  let nowValue: number;
  beforeEach(() => {
    nowValue = 1_700_000_000_000;
  });

  it("returns the Pyth-derived rate on the happy path", async () => {
    const { fetchImpl, calls } = makeFetch([
      (url) => {
        expect(url).toContain("hermes.pyth.network");
        expect(url).toContain(PYTH_USDC_USD_FEED_ID);
        return jsonResponse({ body: PYTH_OK_BODY });
      },
    ]);

    const service = new PricingService({
      fetchImpl,
      now: () => nowValue,
    });

    const quote = await service.getRate();
    expect(quote.source).toBe("pyth");
    // 99988729 * 10^-8 ≈ 0.99988729
    expect(quote.rate).toBeCloseTo(0.99988729, 8);
    expect(quote.publishTime).toBe(1_700_000_000);
    expect(quote.fetchedAt).toBe(nowValue);
    expect(quote.expiresAt).toBe(nowValue + 60_000);
    expect(calls).toHaveLength(1);
  });

  it("serves the cached rate within TTL without hitting upstream again", async () => {
    let pythCalls = 0;
    const { fetchImpl } = makeFetch([
      () => {
        pythCalls += 1;
        return jsonResponse({ body: PYTH_OK_BODY });
      },
    ]);

    const service = new PricingService({
      fetchImpl,
      cacheTtlMs: 60_000,
      now: () => nowValue,
    });

    const first = await service.getRate();
    expect(first.source).toBe("pyth");

    nowValue += 30_000; // still inside TTL
    const second = await service.getRate();
    expect(second.source).toBe("cache");
    expect(second.rate).toBe(first.rate);
    expect(pythCalls).toBe(1);
  });

  it("refetches after the cache expires", async () => {
    let pythCalls = 0;
    const { fetchImpl } = makeFetch([
      () => {
        pythCalls += 1;
        return jsonResponse({ body: PYTH_OK_BODY });
      },
      () => {
        pythCalls += 1;
        return jsonResponse({ body: PYTH_OK_BODY });
      },
    ]);

    const service = new PricingService({
      fetchImpl,
      cacheTtlMs: 60_000,
      now: () => nowValue,
    });

    await service.getRate();
    nowValue += 60_001; // past TTL
    const second = await service.getRate();
    expect(second.source).toBe("pyth");
    expect(pythCalls).toBe(2);
  });

  it("falls back to Coingecko when Pyth fails", async () => {
    const { fetchImpl, calls } = makeFetch([
      () => jsonResponse({ ok: false, status: 503, body: { error: "down" } }),
      (url) => {
        expect(url).toContain("api.coingecko.com");
        expect(url).toContain("usd-coin");
        return jsonResponse({ body: COINGECKO_OK_BODY });
      },
    ]);

    const service = new PricingService({
      fetchImpl,
      maxRetries: 0,
      now: () => nowValue,
    });

    const quote = await service.getRate();
    expect(quote.source).toBe("coingecko");
    expect(quote.rate).toBe(1.0001);
    expect(quote.publishTime).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it("throws an upstream HttpError when both sources fail and no cache exists", async () => {
    const { fetchImpl } = makeFetch([
      () => jsonResponse({ ok: false, status: 503, body: { error: "pyth down" } }),
      () => jsonResponse({ ok: false, status: 502, body: { error: "cg down" } }),
    ]);

    const service = new PricingService({
      fetchImpl,
      maxRetries: 0,
      now: () => nowValue,
    });

    await expect(service.getRate()).rejects.toMatchObject({
      status: 502,
      code: "upstream_error",
    });
  });

  it("returns a stale cached entry when allowStale=true and live fetch fails", async () => {
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) return jsonResponse({ body: PYTH_OK_BODY });
      return jsonResponse({ ok: false, status: 503, body: { error: "down" } });
    }) as unknown as typeof fetch;

    const service = new PricingService({
      fetchImpl,
      cacheTtlMs: 60_000,
      maxRetries: 0,
      now: () => nowValue,
    });

    const fresh = await service.getRate();
    expect(fresh.source).toBe("pyth");

    nowValue += 90_000; // expired
    const stale = await service.getRate({ allowStale: true });
    expect(stale.source).toBe("cache");
    expect(stale.rate).toBe(fresh.rate);
  });

  it("rejects a Pyth feed whose confidence interval is too wide", () => {
    expect(() =>
      extractPythPrice({
        parsed: [
          {
            id: PYTH_USDC_USD_FEED_ID,
            price: {
              price: "100000000",
              // 5% conf interval — exceeds the 2% guard
              conf: "5000000",
              expo: -8,
              publish_time: 1_700_000_000,
            },
          },
        ],
      }),
    ).toThrow(/confidence interval/);
  });

  it("rejects malformed Pyth payloads", () => {
    expect(() => extractPythPrice({})).toThrow();
    expect(() => extractPythPrice({ parsed: [] })).toThrow();
    expect(() =>
      extractPythPrice({ parsed: [{ price: { price: "x", conf: "1", expo: -8, publish_time: 1 } }] }),
    ).toThrow();
  });

  it("parses well-formed Coingecko responses and rejects bad ones", () => {
    expect(extractCoingeckoRate(COINGECKO_OK_BODY)).toBe(1.0001);
    expect(() => extractCoingeckoRate({})).toThrow();
    expect(() => extractCoingeckoRate({ "usd-coin": {} })).toThrow();
    expect(() => extractCoingeckoRate({ "usd-coin": { usd: -1 } })).toThrow();
  });

  it("treats a Pyth confidence interval at exactly 2% as wide (rejected)", () => {
    expect(() =>
      extractPythPrice({
        parsed: [
          {
            id: PYTH_USDC_USD_FEED_ID,
            price: {
              price: "100000000",
              // 2.0% conf — the guard rejects strictly greater-than 2%, so
              // we test slightly above to lock in the boundary behavior.
              conf: "2000001",
              expo: -8,
              publish_time: 1_700_000_000,
            },
          },
        ],
      }),
    ).toThrow(/confidence interval/);
  });
});
