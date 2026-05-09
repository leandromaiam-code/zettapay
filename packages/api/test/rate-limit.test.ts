import { describe, it, expect, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import {
  MemoryRateLimitStore,
  type RateLimitDecision,
  type RateLimitStore,
} from "../src/lib/rate-limit-store.js";
import {
  apiKeyResolver,
  extractApiKey,
  extractClientIp,
  ipResolver,
  rateLimit,
} from "../src/middleware/rate-limit.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { RateLimitError } from "../src/lib/errors.js";

interface ServerHandle {
  url: string;
  close: () => Promise<void>;
}

function startServer(app: express.Express): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe("MemoryRateLimitStore", () => {
  it("allows up to the configured max within the window", async () => {
    const store = new MemoryRateLimitStore({ now: () => 1_000_000 });
    const max = 3;
    const window = 60_000;

    const a = await store.hit("k", window, max);
    const b = await store.hit("k", window, max);
    const c = await store.hit("k", window, max);
    const d = await store.hit("k", window, max);

    expect(a.allowed).toBe(true);
    expect(a.remaining).toBe(2);
    expect(b.allowed).toBe(true);
    expect(b.remaining).toBe(1);
    expect(c.allowed).toBe(true);
    expect(c.remaining).toBe(0);
    expect(d.allowed).toBe(false);
    expect(d.remaining).toBe(0);
    expect(d.count).toBe(3);
  });

  it("isolates buckets by key", async () => {
    const store = new MemoryRateLimitStore({ now: () => 1_000_000 });
    const a = await store.hit("alpha", 60_000, 1);
    const b = await store.hit("beta", 60_000, 1);
    const aBlocked = await store.hit("alpha", 60_000, 1);
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    expect(aBlocked.allowed).toBe(false);
  });

  it("expires entries as the sliding window advances", async () => {
    let now = 1_000_000;
    const store = new MemoryRateLimitStore({ now: () => now });
    const max = 2;
    const window = 1_000;

    const r1 = await store.hit("k", window, max);
    const r2 = await store.hit("k", window, max);
    const r3 = await store.hit("k", window, max);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(false);

    now += window + 1;
    const r4 = await store.hit("k", window, max);
    expect(r4.allowed).toBe(true);
    expect(r4.count).toBe(1);
  });

  it("reports resetAtMs as oldest-entry + window", async () => {
    let now = 1_000;
    const store = new MemoryRateLimitStore({ now: () => now });
    const window = 60_000;

    await store.hit("k", window, 5);
    now = 30_000;
    const second = await store.hit("k", window, 5);

    expect(second.resetAtMs).toBe(1_000 + window);
  });
});

describe("rate-limit middleware", () => {
  it("returns 429 with Retry-After + X-RateLimit headers when exhausted", async () => {
    const store = new MemoryRateLimitStore({ now: () => 1_000 });
    const app = express();
    app.set("trust proxy", true);
    app.use(
      rateLimit({
        store,
        max: 2,
        windowMs: 60_000,
        keyResolver: () => "fixed-key",
        scope: "test",
      }),
    );
    app.get("/ping", (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const server = await startServer(app);
    try {
      const r1 = await fetch(`${server.url}/ping`);
      const r2 = await fetch(`${server.url}/ping`);
      const r3 = await fetch(`${server.url}/ping`);

      expect(r1.status).toBe(200);
      expect(r1.headers.get("x-ratelimit-limit")).toBe("2");
      expect(r1.headers.get("x-ratelimit-remaining")).toBe("1");

      expect(r2.status).toBe(200);
      expect(r2.headers.get("x-ratelimit-remaining")).toBe("0");

      expect(r3.status).toBe(429);
      expect(r3.headers.get("retry-after")).toBeTruthy();
      const body = (await r3.json()) as { error: { code: string } };
      expect(body.error.code).toBe("rate_limited");
    } finally {
      await server.close();
    }
  });

  it("skips when keyResolver returns null", async () => {
    const store = new MemoryRateLimitStore();
    const hitSpy = vi.spyOn(store, "hit");
    const app = express();
    app.use(
      rateLimit({
        store,
        max: 1,
        windowMs: 60_000,
        keyResolver: () => null,
        scope: "test",
      }),
    );
    app.get("/ping", (_req, res) => {
      res.json({ ok: true });
    });

    const server = await startServer(app);
    try {
      const res = await fetch(`${server.url}/ping`);
      expect(res.status).toBe(200);
      expect(hitSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("falls open if the store throws", async () => {
    const store: RateLimitStore = {
      hit: async () => {
        throw new Error("store down");
      },
    };
    const app = express();
    app.use(
      rateLimit({
        store,
        max: 5,
        windowMs: 60_000,
        keyResolver: () => "k",
        scope: "test",
      }),
    );
    app.get("/ping", (_req, res) => {
      res.json({ ok: true });
    });

    const server = await startServer(app);
    try {
      const res = await fetch(`${server.url}/ping`);
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("respects the skip predicate", async () => {
    const store = new MemoryRateLimitStore();
    const hitSpy = vi.spyOn(store, "hit");
    const app = express();
    app.use(
      rateLimit({
        store,
        max: 1,
        windowMs: 60_000,
        keyResolver: () => "k",
        scope: "test",
        skip: (req) => req.path === "/healthz",
      }),
    );
    app.get("/healthz", (_req, res) => {
      res.json({ ok: true });
    });
    app.get("/api", (_req, res) => {
      res.json({ ok: true });
    });

    const server = await startServer(app);
    try {
      const a = await fetch(`${server.url}/healthz`);
      const b = await fetch(`${server.url}/healthz`);
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(hitSpy).not.toHaveBeenCalled();
      const c = await fetch(`${server.url}/api`);
      expect(c.status).toBe(200);
      expect(hitSpy).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

describe("identity resolvers", () => {
  function fakeReq(headers: Record<string, string>, ip = "1.2.3.4"): {
    header: (name: string) => string | undefined;
    ip: string;
    socket: { remoteAddress: string };
  } {
    const map = new Map(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    return {
      header: (name) => map.get(name.toLowerCase()),
      ip,
      socket: { remoteAddress: ip },
    };
  }

  it("extractApiKey reads x-api-key header", () => {
    const req = fakeReq({ "x-api-key": "secret-xyz" });
    expect(extractApiKey(req as never)).toBe("secret-xyz");
  });

  it("extractApiKey falls back to Authorization: Bearer", () => {
    const req = fakeReq({ Authorization: "Bearer  abc.def " });
    expect(extractApiKey(req as never)).toBe("abc.def");
  });

  it("extractApiKey returns null when no key present", () => {
    expect(extractApiKey(fakeReq({}) as never)).toBeNull();
  });

  it("extractClientIp prefers first x-forwarded-for entry", () => {
    const req = fakeReq({ "x-forwarded-for": "10.0.0.5, 10.0.0.6" });
    expect(extractClientIp(req as never)).toBe("10.0.0.5");
  });

  it("apiKeyResolver returns key:<value> when key present", () => {
    const req = fakeReq({ "x-api-key": "k1" });
    expect(apiKeyResolver(req as never)).toBe("key:k1");
  });

  it("apiKeyResolver falls back to ip:<addr> when no key", () => {
    const req = fakeReq({}, "9.9.9.9");
    expect(apiKeyResolver(req as never)).toBe("ip:9.9.9.9");
  });

  it("ipResolver always uses ip", () => {
    const req = fakeReq({ "x-api-key": "ignored" }, "8.8.8.8");
    expect(ipResolver(req as never)).toBe("ip:8.8.8.8");
  });
});

describe("RateLimitError", () => {
  it("reports status 429 and rate_limited code", () => {
    const e = new RateLimitError("nope", 30);
    expect(e.status).toBe(429);
    expect(e.code).toBe("rate_limited");
    expect(e.retryAfterSec).toBe(30);
  });
});

describe("RateLimitDecision shape", () => {
  it("matches the documented contract", async () => {
    const store = new MemoryRateLimitStore({ now: () => 5_000 });
    const decision: RateLimitDecision = await store.hit("k", 60_000, 4);
    expect(decision.limit).toBe(4);
    expect(decision.windowMs).toBe(60_000);
    expect(decision.allowed).toBe(true);
  });
});
