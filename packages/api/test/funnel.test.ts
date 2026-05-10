import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  countFunnelEvents,
  recordFunnelEvent,
} from "../src/db/funnel_events.js";
import { computeAnalytics } from "../src/services/analytics.js";
import { registerMerchant } from "../src/services/merchants.js";
import { newId } from "../src/lib/id.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in funnel tests");
  },
} as unknown as SolanaService;

describe("recordFunnelEvent", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("dedupes repeat events for the same (merchant, session, type)", () => {
    const merchant = registerMerchant(db, {
      name: "Dedupe",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "dedupe@test.io",
      webhookUrl: null,
    });

    const a = recordFunnelEvent(db, {
      id: newId("fnl"),
      merchantId: merchant.id,
      sessionId: "sess-1",
      eventType: "view",
    });
    const b = recordFunnelEvent(db, {
      id: newId("fnl"),
      merchantId: merchant.id,
      sessionId: "sess-1",
      eventType: "view",
    });

    expect(b.id).toBe(a.id);
    const counts = countFunnelEvents(db, merchant.id, "1970-01-01T00:00:00.000Z");
    expect(counts).toEqual({ view: 1, checkout: 0, completed: 0 });
  });

  it("counts distinct sessions and types within the window", () => {
    const merchant = registerMerchant(db, {
      name: "Counts",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "counts@test.io",
      webhookUrl: null,
    });

    for (let i = 0; i < 10; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "view",
      });
    }
    for (let i = 0; i < 4; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "checkout",
      });
    }
    for (let i = 0; i < 2; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "completed",
      });
    }

    const counts = countFunnelEvents(
      db,
      merchant.id,
      "1970-01-01T00:00:00.000Z",
    );
    expect(counts).toEqual({ view: 10, checkout: 4, completed: 2 });
  });
});

describe("computeAnalytics — funnel", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns zeroed funnel when there are no events", () => {
    const merchant = registerMerchant(db, {
      name: "Zero",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "zero@test.io",
      webhookUrl: null,
    });

    const { funnel } = computeAnalytics(db, merchant.id);

    expect(funnel.windowDays).toBe(30);
    expect(funnel.steps.map((s) => s.name)).toEqual([
      "view",
      "checkout",
      "completed",
    ]);
    expect(funnel.steps.every((s) => s.count === 0)).toBe(true);
    expect(funnel.dropOff).toHaveLength(2);
    expect(funnel.dropOff.every((d) => d.dropped === 0 && d.rate === 0)).toBe(
      true,
    );
    expect(funnel.overallRate).toBe(0);
  });

  it("computes drop-off rates and overall conversion", () => {
    const merchant = registerMerchant(db, {
      name: "Drop",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "drop@test.io",
      webhookUrl: null,
    });

    // 100 views, 40 checkouts, 30 completed → 60% / 25% drop, 30% overall.
    for (let i = 0; i < 100; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "view",
      });
    }
    for (let i = 0; i < 40; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "checkout",
      });
    }
    for (let i = 0; i < 30; i++) {
      recordFunnelEvent(db, {
        id: newId("fnl"),
        merchantId: merchant.id,
        sessionId: `s-${i}`,
        eventType: "completed",
      });
    }

    const { funnel } = computeAnalytics(db, merchant.id);
    const view = funnel.steps.find((s) => s.name === "view")!;
    const checkout = funnel.steps.find((s) => s.name === "checkout")!;
    const completed = funnel.steps.find((s) => s.name === "completed")!;

    expect(view.count).toBe(100);
    expect(checkout.count).toBe(40);
    expect(completed.count).toBe(30);
    expect(view.conversionFromStart).toBe(1);
    expect(checkout.conversionFromStart).toBeCloseTo(0.4, 5);
    expect(completed.conversionFromStart).toBeCloseTo(0.3, 5);

    expect(funnel.dropOff[0]).toEqual({
      from: "view",
      to: "checkout",
      dropped: 60,
      rate: 0.6,
    });
    expect(funnel.dropOff[1]).toEqual({
      from: "checkout",
      to: "completed",
      dropped: 10,
      rate: 0.25,
    });
    expect(funnel.overallRate).toBeCloseTo(0.3, 5);
  });

  it("clamps drop to zero when a later step exceeds the prior one", () => {
    // Out-of-order tracking (e.g. checkout fired without a matching view)
    // must not produce a negative drop-off.
    const merchant = registerMerchant(db, {
      name: "OOO",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "ooo@test.io",
      webhookUrl: null,
    });

    recordFunnelEvent(db, {
      id: newId("fnl"),
      merchantId: merchant.id,
      sessionId: "lone",
      eventType: "checkout",
    });

    const { funnel } = computeAnalytics(db, merchant.id);
    const drop = funnel.dropOff.find(
      (d) => d.from === "view" && d.to === "checkout",
    )!;
    expect(drop.dropped).toBe(0);
    expect(drop.rate).toBe(0);
  });
});

describe("POST /funnel/track", () => {
  let db: Db;
  let server: import("node:http").Server;
  let baseUrl: string;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const merchant = registerMerchant(db, {
      name: "Track",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "track@test.io",
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  it("records a view event and returns the persisted row", async () => {
    const res = await fetch(`${baseUrl}/funnel/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sessionId: "s-001",
        eventType: "view",
      }),
    });

    expect(res.status).toBe(201);
    const json = (await res.json()) as { event: { eventType: string; sessionId: string } };
    expect(json.event.eventType).toBe("view");
    expect(json.event.sessionId).toBe("s-001");
  });

  it("rejects invalid event types with 400", async () => {
    const res = await fetch(`${baseUrl}/funnel/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sessionId: "s-bad",
        eventType: "abandoned",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 when the merchant does not exist", async () => {
    const res = await fetch(`${baseUrl}/funnel/track`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId: "merchant_does_not_exist",
        sessionId: "s-002",
        eventType: "view",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("is idempotent on repeat events for the same session+type", async () => {
    const body = JSON.stringify({
      merchantId,
      sessionId: "s-dupe",
      eventType: "checkout",
    });
    const headers = { "content-type": "application/json" };
    const r1 = await fetch(`${baseUrl}/funnel/track`, { method: "POST", headers, body });
    const r2 = await fetch(`${baseUrl}/funnel/track`, { method: "POST", headers, body });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const j1 = (await r1.json()) as { event: { id: string } };
    const j2 = (await r2.json()) as { event: { id: string } };
    expect(j2.event.id).toBe(j1.event.id);
  });
});
