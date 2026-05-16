import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { findMerchantById } from "../src/db/merchants.js";
import {
  insertPayment,
  markPaymentCompleted,
} from "../src/db/payments.js";
import { enforceBetaLimits } from "../src/beta/enforcer.js";
import { betaStatusSnapshot } from "../src/beta/monitoring.js";
import {
  betaEndsAt,
  isBetaExpired,
  loadBetaConfig,
  type BetaLaunchConfig,
} from "../src/beta/config.js";
import { HttpError } from "../src/lib/errors.js";
import { ConfigurationError } from "../src/lib/errors.js";
import type { SolanaService } from "../src/services/solana.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: express.Express): Promise<RunningServer> {
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

function makeFakeSolana(payerKp: Keypair): SolanaService {
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () =>
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(
      async (params: { recipientOwner: PublicKey; amount: number }) => ({
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}_${Math.random()}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
        currency: "USDC",
        mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }),
    ),
  } as unknown as SolanaService;
}

function buildBetaConfig(overrides: Partial<BetaLaunchConfig> = {}): BetaLaunchConfig {
  return {
    enabled: true,
    allowlist: new Set<string>(),
    merchantCapUsd: 10_000,
    maxMerchants: 10,
    launchAt: null,
    durationDays: 30,
    ...overrides,
  };
}

describe("loadBetaConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("disabled by default with empty allowlist", () => {
    delete process.env.BETA_MODE_ENABLED;
    delete process.env.BETA_ALLOWED_MERCHANTS;
    const cfg = loadBetaConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.allowlist.size).toBe(0);
    expect(cfg.merchantCapUsd).toBe(10_000);
    expect(cfg.maxMerchants).toBe(10);
    expect(cfg.durationDays).toBe(30);
  });

  it("parses CSV allowlist trimming whitespace and skipping empties", () => {
    process.env.BETA_MODE_ENABLED = "true";
    process.env.BETA_ALLOWED_MERCHANTS = " merch_a , , merch_b,merch_c";
    const cfg = loadBetaConfig();
    expect(cfg.enabled).toBe(true);
    expect([...cfg.allowlist].sort()).toEqual([
      "merch_a",
      "merch_b",
      "merch_c",
    ]);
  });

  it("rejects an allowlist exceeding the curated cap", () => {
    process.env.BETA_MODE_ENABLED = "true";
    process.env.BETA_MAX_MERCHANTS = "3";
    process.env.BETA_ALLOWED_MERCHANTS = "a,b,c,d";
    expect(() => loadBetaConfig()).toThrow(ConfigurationError);
  });

  it("normalizes BETA_LAUNCH_AT into ISO", () => {
    process.env.BETA_LAUNCH_AT = "2026-05-10T00:00:00Z";
    const cfg = loadBetaConfig();
    expect(cfg.launchAt).toBe("2026-05-10T00:00:00.000Z");
  });

  it("rejects unparseable BETA_LAUNCH_AT", () => {
    process.env.BETA_LAUNCH_AT = "not-a-date";
    expect(() => loadBetaConfig()).toThrow(ConfigurationError);
  });

  it("accepts BETA_MERCHANT_CAP_USDC=0 as the Z30.5 cap-removal sentinel", () => {
    process.env.BETA_MERCHANT_CAP_USDC = "0";
    const cfg = loadBetaConfig();
    expect(cfg.merchantCapUsd).toBe(0);
  });

  it("rejects negative BETA_MERCHANT_CAP_USDC", () => {
    process.env.BETA_MERCHANT_CAP_USDC = "-1";
    expect(() => loadBetaConfig()).toThrow(ConfigurationError);
  });

  it("still rejects BETA_MAX_MERCHANTS=0 and BETA_DURATION_DAYS=0", () => {
    process.env.BETA_MAX_MERCHANTS = "0";
    expect(() => loadBetaConfig()).toThrow(ConfigurationError);
    delete process.env.BETA_MAX_MERCHANTS;
    process.env.BETA_DURATION_DAYS = "0";
    expect(() => loadBetaConfig()).toThrow(ConfigurationError);
  });
});

describe("betaEndsAt / isBetaExpired", () => {
  it("returns null end date when launchAt is unset", () => {
    const cfg = buildBetaConfig({ launchAt: null });
    expect(betaEndsAt(cfg)).toBeNull();
    expect(isBetaExpired(cfg)).toBe(false);
  });

  it("computes end date as launchAt + durationDays", () => {
    const cfg = buildBetaConfig({
      launchAt: "2026-05-01T00:00:00.000Z",
      durationDays: 30,
    });
    expect(betaEndsAt(cfg)).toBe("2026-05-31T00:00:00.000Z");
  });

  it("flags expiry once now passes the end date", () => {
    const cfg = buildBetaConfig({
      launchAt: "2026-05-01T00:00:00.000Z",
      durationDays: 30,
    });
    expect(isBetaExpired(cfg, new Date("2026-05-15T00:00:00Z"))).toBe(false);
    expect(isBetaExpired(cfg, new Date("2026-05-31T00:00:01Z"))).toBe(true);
  });
});

describe("enforceBetaLimits", () => {
  let db: Db;
  let merchantId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Beta Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `b-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("is a no-op when disabled", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const cfg = buildBetaConfig({ enabled: false });
    const result = enforceBetaLimits(db, cfg, { merchant, amount: 99_999 });
    expect(result.enforced).toBe(false);
  });

  it("blocks merchants outside the allowlist with 403", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const cfg = buildBetaConfig({ allowlist: new Set(["other_merch"]) });
    let caught: HttpError | null = null;
    try {
      enforceBetaLimits(db, cfg, { merchant, amount: 100 });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(403);
    expect(caught?.code).toBe("forbidden");
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("beta:allowlist");
  });

  it("allows allowlisted merchants under the cap", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const cfg = buildBetaConfig({ allowlist: new Set([merchantId]) });
    const result = enforceBetaLimits(db, cfg, { merchant, amount: 500 });
    expect(result.enforced).toBe(true);
    expect(result.cumulativeUsd).toBe(0);
    expect(result.remainingUsd).toBe(10_000);
  });

  it("rejects payments crossing the $10k merchant cap with 429", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const cfg = buildBetaConfig({ allowlist: new Set([merchantId]) });
    // Seed $9,500 of completed spend.
    for (let i = 0; i < 19; i += 1) {
      const id = `pay_seed_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 500,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_${i}`);
    }
    // $9,500 + $600 = $10,100 -> over the $10k cap.
    let caught: HttpError | null = null;
    try {
      enforceBetaLimits(db, cfg, { merchant, amount: 600 });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(429);
    const details = caught?.details as { scope: string; cumulativeUsd: number };
    expect(details.scope).toBe("beta:merchant_cap");
    expect(details.cumulativeUsd).toBe(9_500);
  });

  it("ignores spend predating launchAt", () => {
    const merchant = findMerchantById(db, merchantId)!;
    // Backdate $9,000 of spend to BEFORE the beta launchAt — it must not consume budget.
    const beforeIso = "2025-01-01T00:00:00.000Z";
    for (let i = 0; i < 9; i += 1) {
      const id = `pay_old_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1_000,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      db.prepare(
        `UPDATE payments SET status = 'completed', tx_signature = ?, created_at = ? WHERE id = ?`,
      ).run(`sig_old_${i}`, beforeIso, id);
    }
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      launchAt: "2026-01-01T00:00:00.000Z",
    });
    const result = enforceBetaLimits(db, cfg, {
      merchant,
      amount: 100,
      now: new Date("2026-01-15T00:00:00Z"),
    });
    expect(result.cumulativeUsd).toBe(0);
  });

  it("blocks all payments after the beta window expires with 403", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      launchAt: "2026-01-01T00:00:00.000Z",
      durationDays: 30,
    });
    let caught: HttpError | null = null;
    try {
      enforceBetaLimits(db, cfg, {
        merchant,
        amount: 1,
        now: new Date("2026-03-15T00:00:00Z"),
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(403);
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("beta:window_expired");
  });

  it("Z30.5 cap=0 — skips the volume gate but keeps allowlist + window active", () => {
    const merchant = findMerchantById(db, merchantId)!;
    // Seed $50k of completed spend — would blow past any positive cap.
    for (let i = 0; i < 50; i += 1) {
      const id = `pay_big_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1_000,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_big_${i}`);
    }
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      merchantCapUsd: 0,
    });
    const result = enforceBetaLimits(db, cfg, { merchant, amount: 25_000 });
    expect(result.enforced).toBe(true);
    expect(result.capUsd).toBe(0);
    expect(result.remainingUsd).toBe(Number.POSITIVE_INFINITY);
    expect(result.cumulativeUsd).toBe(50_000);

    // Allowlist still armed even under cap=0.
    const cfgNoList = buildBetaConfig({
      allowlist: new Set(["other"]),
      merchantCapUsd: 0,
    });
    expect(() =>
      enforceBetaLimits(db, cfgNoList, { merchant, amount: 1 }),
    ).toThrow(HttpError);

    // Window expiry still armed even under cap=0.
    const cfgExpired = buildBetaConfig({
      allowlist: new Set([merchantId]),
      merchantCapUsd: 0,
      launchAt: "2026-01-01T00:00:00.000Z",
      durationDays: 30,
    });
    expect(() =>
      enforceBetaLimits(db, cfgExpired, {
        merchant,
        amount: 1,
        now: new Date("2026-04-01T00:00:00Z"),
      }),
    ).toThrow(HttpError);
  });

  it("does not count failed payments toward the cap", () => {
    const merchant = findMerchantById(db, merchantId)!;
    for (let i = 0; i < 20; i += 1) {
      const id = `pay_failed_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1_000,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      db.prepare(
        `UPDATE payments SET status = 'failed', error_message = 'rpc' WHERE id = ?`,
      ).run(id);
    }
    const cfg = buildBetaConfig({ allowlist: new Set([merchantId]) });
    expect(() =>
      enforceBetaLimits(db, cfg, { merchant, amount: 100 }),
    ).not.toThrow();
  });
});

describe("betaStatusSnapshot", () => {
  let db: Db;
  let merchantId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Snap Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `s-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("reports utilization and totals across the cohort", () => {
    // Seed $7,500 of spend so utilization sits at 75%.
    for (let i = 0; i < 15; i += 1) {
      const id = `pay_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 500,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_${i}`);
    }
    const cfg = buildBetaConfig({ allowlist: new Set([merchantId]) });
    const snap = betaStatusSnapshot(db, cfg);
    expect(snap.enabled).toBe(true);
    expect(snap.allowlistSize).toBe(1);
    expect(snap.utilization).toHaveLength(1);
    expect(snap.utilization[0]?.cumulativeUsd).toBe(7_500);
    expect(snap.utilization[0]?.utilizationPct).toBe(75);
    expect(snap.utilization[0]?.exhausted).toBe(false);
    expect(snap.totals.cumulativeUsd).toBe(7_500);
    expect(snap.totals.merchantsExhausted).toBe(0);
  });

  it("computes daysRemaining from launchAt + durationDays", () => {
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      launchAt: "2026-05-01T00:00:00.000Z",
      durationDays: 30,
    });
    const snap = betaStatusSnapshot(db, cfg, new Date("2026-05-15T00:00:00Z"));
    expect(snap.endsAt).toBe("2026-05-31T00:00:00.000Z");
    expect(snap.daysRemaining).toBe(16);
    expect(snap.expired).toBe(false);
  });

  it("Z30.5 cap=0 — reports exhausted=false / utilization=0 / remaining=Infinity even with heavy spend", () => {
    for (let i = 0; i < 50; i += 1) {
      const id = `pay_post_cap_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1_000,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_post_cap_${i}`);
    }
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      merchantCapUsd: 0,
    });
    const snap = betaStatusSnapshot(db, cfg);
    const row = snap.utilization[0]!;
    expect(row.cumulativeUsd).toBe(50_000);
    expect(row.capUsd).toBe(0);
    expect(row.utilizationPct).toBe(0);
    expect(row.remainingUsd).toBe(Number.POSITIVE_INFINITY);
    expect(row.exhausted).toBe(false);
    expect(snap.totals.merchantsExhausted).toBe(0);
  });

  it("flips exhausted/expired correctly past the cap and end date", () => {
    for (let i = 0; i < 20; i += 1) {
      const id = `pay_full_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 500,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_full_${i}`);
    }
    const cfg = buildBetaConfig({
      allowlist: new Set([merchantId]),
      launchAt: "2026-01-01T00:00:00.000Z",
    });
    const snap = betaStatusSnapshot(db, cfg, new Date("2026-04-01T00:00:00Z"));
    expect(snap.utilization[0]?.exhausted).toBe(true);
    expect(snap.totals.merchantsExhausted).toBe(1);
    expect(snap.daysRemaining).toBe(0);
    expect(snap.expired).toBe(true);
  });
});

describe("GET /beta/status", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Status Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `st-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({
      db,
      solana,
      betaConfig: buildBetaConfig({
        allowlist: new Set([merchantId]),
        launchAt: "2026-05-01T00:00:00.000Z",
      }),
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("returns the current snapshot", async () => {
    const res = await fetch(`${server.url}/beta/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      enabled: boolean;
      allowlistSize: number;
      capUsd: number;
      utilization: Array<{ merchantId: string }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.allowlistSize).toBe(1);
    expect(body.capUsd).toBe(10_000);
    expect(body.utilization[0]?.merchantId).toBe(merchantId);
  });
});

describe("POST /pay beta enforcement", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Pay Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `p-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerKp = Keypair.generate();
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("returns 403 forbidden when merchant is not on the allowlist", async () => {
    const solana = makeFakeSolana(payerKp);
    const app = createApp({
      db,
      solana,
      betaConfig: buildBetaConfig({ allowlist: new Set(["other_merch"]) }),
    });
    server = await startApp(app);
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1 }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details.scope).toBe("beta:allowlist");
  });

  it("returns 429 once the merchant cap is reached", async () => {
    const solana = makeFakeSolana(payerKp);
    const app = createApp({
      db,
      solana,
      betaConfig: buildBetaConfig({
        allowlist: new Set([merchantId]),
        merchantCapUsd: 50,
      }),
    });
    server = await startApp(app);
    // Exhaust the cap with two $25 successful payments.
    for (let i = 0; i < 2; i += 1) {
      const ok = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          merchantId,
          amount: 25,
          payerWallet: Keypair.generate().publicKey.toBase58(),
        }),
      });
      expect(ok.status).toBe(201);
    }
    const over = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(over.status).toBe(429);
    const body = (await over.json()) as {
      error: { code: string; details: { scope: string } };
    };
    expect(body.error.code).toBe("rate_limited");
    expect(body.error.details.scope).toBe("beta:merchant_cap");
  });

  it("permits payments when beta mode is disabled", async () => {
    const solana = makeFakeSolana(payerKp);
    const app = createApp({
      db,
      solana,
      betaConfig: buildBetaConfig({ enabled: false }),
    });
    server = await startApp(app);
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1 }),
    });
    expect(res.status).toBe(201);
  });
});
