import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  advanceChargeDate,
  insertSubscription,
  listDueSubscriptions,
  listSubscriptionsByMerchant,
  recordSubscriptionCharge,
  updateSubscriptionStatus,
} from "../src/db/subscriptions.js";
import { newId } from "../src/lib/id.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in subscription tests");
  },
} as unknown as SolanaService;

describe("subscriptions repository", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("creates a subscription with default 'active' status and persists fields", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: null,
    });
    const customerWallet = Keypair.generate().publicKey.toBase58();
    const nextChargeAt = new Date("2026-06-01T00:00:00.000Z").toISOString();

    const sub = insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet,
      amount: 9.99,
      interval: "monthly",
      nextChargeAt,
      currency: "USDC",
      metadata: { plan: "pro" },
    });

    expect(sub.id).toMatch(/^sub_/);
    expect(sub.merchantId).toBe(merchant.id);
    expect(sub.customerWallet).toBe(customerWallet);
    expect(sub.amount).toBe(9.99);
    expect(sub.currency).toBe("USDC");
    expect(sub.interval).toBe("monthly");
    expect(sub.status).toBe("active");
    expect(sub.nextChargeAt).toBe(nextChargeAt);
    expect(sub.lastChargeAt).toBeNull();
    expect(sub.metadata).toEqual({ plan: "pro" });
  });

  it("rejects amounts <= 0 via the CHECK constraint", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "two@test.io",
      webhookUrl: null,
    });
    expect(() =>
      insertSubscription(db, {
        id: newId("sub"),
        merchantId: merchant.id,
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 0,
        interval: "weekly",
        nextChargeAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("rejects unknown intervals via the CHECK constraint", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "three@test.io",
      webhookUrl: null,
    });
    expect(() =>
      insertSubscription(db, {
        id: newId("sub"),
        merchantId: merchant.id,
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 1,
        interval: "yearly" as never,
        nextChargeAt: new Date().toISOString(),
      }),
    ).toThrow();
  });

  it("listDueSubscriptions returns only active subs whose next_charge_at <= now", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "four@test.io",
      webhookUrl: null,
    });

    const past = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const future = new Date("2099-01-01T00:00:00.000Z").toISOString();
    const dueSub = insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 5,
      interval: "daily",
      nextChargeAt: past,
    });
    insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 5,
      interval: "daily",
      nextChargeAt: future,
    });
    const pausedSub = insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 5,
      interval: "daily",
      nextChargeAt: past,
    });
    updateSubscriptionStatus(db, pausedSub.id, "paused");

    const due = listDueSubscriptions(db, new Date("2026-05-10T00:00:00.000Z").toISOString());
    expect(due.map((s) => s.id)).toEqual([dueSub.id]);
  });

  it("recordSubscriptionCharge advances next_charge_at and stamps last_charge_at", () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "five@test.io",
      webhookUrl: null,
    });
    const startNext = new Date("2026-05-10T00:00:00.000Z").toISOString();
    const sub = insertSubscription(db, {
      id: newId("sub"),
      merchantId: merchant.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 5,
      interval: "weekly",
      nextChargeAt: startNext,
    });

    const chargedAt = new Date("2026-05-10T12:00:00.000Z").toISOString();
    const advanced = advanceChargeDate(new Date(startNext), "weekly").toISOString();
    const updated = recordSubscriptionCharge(db, sub.id, chargedAt, advanced);

    expect(updated.lastChargeAt).toBe(chargedAt);
    expect(updated.nextChargeAt).toBe(advanced);
    expect(updated.status).toBe("active");
  });

  it("listSubscriptionsByMerchant scopes results to a single merchant", () => {
    const a = registerMerchant(db, {
      name: "A",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "merchant.a@test.io",
      webhookUrl: null,
    });
    const b = registerMerchant(db, {
      name: "B",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "merchant.b@test.io",
      webhookUrl: null,
    });
    insertSubscription(db, {
      id: newId("sub"),
      merchantId: a.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 1,
      interval: "daily",
      nextChargeAt: new Date().toISOString(),
    });
    insertSubscription(db, {
      id: newId("sub"),
      merchantId: b.id,
      customerWallet: Keypair.generate().publicKey.toBase58(),
      amount: 2,
      interval: "daily",
      nextChargeAt: new Date().toISOString(),
    });

    const aSubs = listSubscriptionsByMerchant(db, a.id);
    expect(aSubs.length).toBe(1);
    expect(aSubs[0]?.merchantId).toBe(a.id);
  });
});

describe("advanceChargeDate", () => {
  it("daily increments by one day", () => {
    const next = advanceChargeDate(new Date("2026-05-10T00:00:00.000Z"), "daily");
    expect(next.toISOString()).toBe("2026-05-11T00:00:00.000Z");
  });

  it("weekly increments by seven days", () => {
    const next = advanceChargeDate(new Date("2026-05-10T00:00:00.000Z"), "weekly");
    expect(next.toISOString()).toBe("2026-05-17T00:00:00.000Z");
  });

  it("monthly increments by one month", () => {
    const next = advanceChargeDate(new Date("2026-05-10T00:00:00.000Z"), "monthly");
    expect(next.toISOString()).toBe("2026-06-10T00:00:00.000Z");
  });
});

describe("subscriptions HTTP routes", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let apiKey: string;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "owner@acme.test",
      webhookUrl: null,
    });
    apiKey = merchant.apiKey;
    merchantId = merchant.id;
    const app = createApp({ db, solana: dummySolana });
    await new Promise<void>((resolve) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        url = `http://127.0.0.1:${port}`;
        close = () =>
          new Promise<void>((r) => {
            server.close(() => r());
          });
        resolve();
      });
    });
  });

  afterEach(async () => {
    await close();
    closeDatabase();
  });

  it("creates a subscription via POST /subscriptions", async () => {
    const customerWallet = Keypair.generate().publicKey.toBase58();
    const res = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": apiKey,
      },
      body: JSON.stringify({
        customerWallet,
        amount: 12.5,
        interval: "monthly",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      subscription: {
        id: string;
        merchantId: string;
        customerWallet: string;
        amount: number;
        interval: string;
        status: string;
        nextChargeAt: string;
      };
    };
    expect(body.subscription.id).toMatch(/^sub_/);
    expect(body.subscription.merchantId).toBe(merchantId);
    expect(body.subscription.customerWallet).toBe(customerWallet);
    expect(body.subscription.interval).toBe("monthly");
    expect(body.subscription.status).toBe("active");
    expect(Date.parse(body.subscription.nextChargeAt)).toBeGreaterThan(Date.now());
  });

  it("rejects unauthenticated POST /subscriptions with 401", async () => {
    const res = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 1,
        interval: "daily",
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects unsupported intervals with 400", async () => {
    const res = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": apiKey,
      },
      body: JSON.stringify({
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 1,
        interval: "yearly",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("lists subscriptions for the authenticated merchant", async () => {
    await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": apiKey,
      },
      body: JSON.stringify({
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 5,
        interval: "weekly",
      }),
    });
    const res = await fetch(`${url}/subscriptions`, {
      headers: { "x-zettapay-api-key": apiKey },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscriptions: Array<{ id: string }>;
    };
    expect(body.subscriptions.length).toBe(1);
  });

  it("cancels a subscription via POST /subscriptions/:id/cancel", async () => {
    const create = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": apiKey,
      },
      body: JSON.stringify({
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 5,
        interval: "weekly",
      }),
    });
    const created = (await create.json()) as { subscription: { id: string } };

    const cancel = await fetch(
      `${url}/subscriptions/${created.subscription.id}/cancel`,
      {
        method: "POST",
        headers: { "x-zettapay-api-key": apiKey },
      },
    );
    expect(cancel.status).toBe(200);
    const body = (await cancel.json()) as {
      subscription: { status: string };
    };
    expect(body.subscription.status).toBe("canceled");
  });

  it("scopes /subscriptions/:id to the owning merchant", async () => {
    const create = await fetch(`${url}/subscriptions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": apiKey,
      },
      body: JSON.stringify({
        customerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 5,
        interval: "weekly",
      }),
    });
    const created = (await create.json()) as { subscription: { id: string } };

    const intruder = registerMerchant(db, {
      name: "Intruder",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "intruder@x.test",
      webhookUrl: null,
    });
    const res = await fetch(
      `${url}/subscriptions/${created.subscription.id}`,
      { headers: { "x-zettapay-api-key": intruder.apiKey } },
    );
    expect(res.status).toBe(404);
  });
});
