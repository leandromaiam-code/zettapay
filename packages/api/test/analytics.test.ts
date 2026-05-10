import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { insertSubscription } from "../src/db/subscriptions.js";
import { newId } from "../src/lib/id.js";
import { computeAnalytics } from "../src/services/analytics.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in analytics tests");
  },
} as unknown as SolanaService;

function seedPayment(
  db: Db,
  merchantId: string,
  payerWallet: string,
  amount: number,
  status: "completed" | "failed" | "pending",
  createdAt: string,
  completedAt: string | null = null,
): string {
  const id = newId("pay");
  db.prepare(
    `INSERT INTO payments (
       id, merchant_id, amount_usdc, payer_wallet, status,
       tx_signature, currency, created_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'USDC', ?, ?)`,
  ).run(
    id,
    merchantId,
    amount,
    payerWallet,
    status,
    status === "completed" ? `sig_${id}` : null,
    createdAt,
    completedAt,
  );
  return id;
}

describe("computeAnalytics", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns zeroed metrics when there is no payment activity", () => {
    const merchant = registerMerchant(db, {
      name: "Empty",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "empty@test.io",
      webhookUrl: null,
    });

    const analytics = computeAnalytics(db, merchant.id);

    expect(analytics.tpv.today).toEqual({ amount: 0, count: 0 });
    expect(analytics.tpv.week).toEqual({ amount: 0, count: 0 });
    expect(analytics.tpv.month).toEqual({ amount: 0, count: 0 });
    expect(analytics.tpvSeries).toHaveLength(30);
    expect(analytics.tpvSeries.every((p) => p.amount === 0)).toBe(true);
    expect(analytics.mrr).toBe(0);
    expect(analytics.conversion.rate).toBe(0);
    expect(analytics.topCustomers).toEqual([]);
  });

  it("aggregates TPV across today/week/month windows from completed payments", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "tpv@test.io",
      webhookUrl: null,
    });
    const wallet = Keypair.generate().publicKey.toBase58();

    const now = new Date("2026-05-10T12:00:00.000Z");
    const todayStart = new Date("2026-05-10T00:00:00.000Z");
    const earlierToday = new Date("2026-05-10T03:00:00.000Z");
    const threeDaysAgo = new Date("2026-05-07T11:00:00.000Z");
    const fifteenDaysAgo = new Date("2026-04-25T08:00:00.000Z");
    const sixtyDaysAgo = new Date("2026-03-11T08:00:00.000Z");

    seedPayment(db, merchant.id, wallet, 50, "completed", earlierToday.toISOString(), earlierToday.toISOString());
    seedPayment(db, merchant.id, wallet, 25, "completed", todayStart.toISOString(), todayStart.toISOString());
    seedPayment(db, merchant.id, wallet, 100, "completed", threeDaysAgo.toISOString(), threeDaysAgo.toISOString());
    seedPayment(db, merchant.id, wallet, 200, "completed", fifteenDaysAgo.toISOString(), fifteenDaysAgo.toISOString());
    // Outside the 30d window — must not be counted in any reported total.
    seedPayment(db, merchant.id, wallet, 999, "completed", sixtyDaysAgo.toISOString(), sixtyDaysAgo.toISOString());

    const analytics = computeAnalytics(db, merchant.id, now);

    expect(analytics.tpv.today).toEqual({ amount: 75, count: 2 });
    expect(analytics.tpv.week).toEqual({ amount: 175, count: 3 });
    expect(analytics.tpv.month).toEqual({ amount: 375, count: 4 });
    expect(analytics.tpvSeries).toHaveLength(30);
    expect(analytics.tpvSeries.at(-1)).toEqual({
      date: "2026-05-10",
      amount: 75,
      count: 2,
    });
  });

  it("computes conversion rate from completed/failed without counting pending", () => {
    const merchant = registerMerchant(db, {
      name: "Conv",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "conv@test.io",
      webhookUrl: null,
    });
    const wallet = Keypair.generate().publicKey.toBase58();
    const now = new Date("2026-05-10T12:00:00.000Z");
    const at = new Date("2026-05-09T10:00:00.000Z").toISOString();

    seedPayment(db, merchant.id, wallet, 10, "completed", at, at);
    seedPayment(db, merchant.id, wallet, 10, "completed", at, at);
    seedPayment(db, merchant.id, wallet, 10, "completed", at, at);
    seedPayment(db, merchant.id, wallet, 10, "failed", at);
    seedPayment(db, merchant.id, wallet, 10, "pending", at);

    const analytics = computeAnalytics(db, merchant.id, now);

    expect(analytics.conversion.total).toBe(5);
    expect(analytics.conversion.completed).toBe(3);
    expect(analytics.conversion.failed).toBe(1);
    expect(analytics.conversion.pending).toBe(1);
    expect(analytics.conversion.rate).toBeCloseTo(0.75, 5);
  });

  it("ranks top customers by total spend, ignoring failed payments", () => {
    const merchant = registerMerchant(db, {
      name: "Top",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "top@test.io",
      webhookUrl: null,
    });
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const w3 = Keypair.generate().publicKey.toBase58();
    const now = new Date("2026-05-10T12:00:00.000Z");
    const at = new Date("2026-05-08T09:00:00.000Z").toISOString();

    seedPayment(db, merchant.id, w1, 50, "completed", at, at);
    seedPayment(db, merchant.id, w1, 75, "completed", at, at);
    seedPayment(db, merchant.id, w2, 200, "completed", at, at);
    seedPayment(db, merchant.id, w3, 300, "failed", at);

    const analytics = computeAnalytics(db, merchant.id, now);

    expect(analytics.topCustomers.map((c) => c.payerWallet)).toEqual([w2, w1]);
    expect(analytics.topCustomers[0]).toMatchObject({
      payerWallet: w2,
      totalUsdc: 200,
      txCount: 1,
    });
    expect(analytics.topCustomers[1]).toMatchObject({
      payerWallet: w1,
      totalUsdc: 125,
      txCount: 2,
    });
  });

  it("normalizes weekly and daily subscriptions into MRR", () => {
    const merchant = registerMerchant(db, {
      name: "Sub",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "sub@test.io",
      webhookUrl: null,
    });
    const customer = Keypair.generate().publicKey.toBase58();
    const nextChargeAt = new Date("2026-06-01T00:00:00.000Z").toISOString();

    insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: customer,
      amount: 10,
      interval: "monthly",
      nextChargeAt,
    });
    insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: customer,
      amount: 5,
      interval: "weekly",
      nextChargeAt,
    });
    // Canceled subscriptions must not contribute to MRR.
    const canceled = insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: customer,
      amount: 999,
      interval: "monthly",
      nextChargeAt,
    });
    db.prepare("UPDATE subscriptions SET status = 'canceled' WHERE id = ?").run(
      canceled.id,
    );

    const analytics = computeAnalytics(db, merchant.id);
    // 10 monthly + 5 weekly (5 * 52/12 = 21.666…) ≈ 31.666…
    expect(analytics.mrr).toBeCloseTo(10 + (5 * 52) / 12, 5);
  });
});

describe("GET /analytics", () => {
  let db: Db;
  let server: import("node:http").Server;
  let baseUrl: string;
  let apiKey: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = app.listen(0);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "route@test.io",
      webhookUrl: null,
    });
    apiKey = merchant.apiKey;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase();
  });

  it("rejects requests without an API key with 401", async () => {
    const res = await fetch(`${baseUrl}/analytics`);
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown API key with 401", async () => {
    const res = await fetch(`${baseUrl}/analytics`, {
      headers: { "x-zettapay-api-key": "zp_live_unknown" },
    });
    expect(res.status).toBe(401);
  });

  it("returns the analytics envelope for an authenticated merchant", async () => {
    const res = await fetch(`${baseUrl}/analytics`, {
      headers: { "x-zettapay-api-key": apiKey },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { analytics: { tpvSeries: unknown[] } };
    expect(json.analytics).toBeDefined();
    expect(json.analytics.tpvSeries).toHaveLength(30);
  });
});
