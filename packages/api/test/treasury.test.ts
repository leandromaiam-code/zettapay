import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  computeTpvContribution,
  TreasuryService,
} from "../src/services/treasury.js";
import type { SolanaService } from "../src/services/solana.js";
import { insertPayment, markPaymentCompleted } from "../src/db/payments.js";

const ADMIN_KEY = "treasury-admin-key-z22-3-min-len-ok";

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

function fakeSolana(): SolanaService {
  const payerKp = Keypair.generate();
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(async (params: { recipientOwner: PublicKey; amount: number }) => ({
      signature: `sig_${Math.random().toString(36).slice(2, 10)}`,
      payerWallet: payerKp.publicKey.toBase58(),
      recipientWallet: params.recipientOwner.toBase58(),
      amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
      decimals: 6,
      currency: "USDC",
      mintAddress: "mint_USDC",
    })),
  } as unknown as SolanaService;
}

function buildAuthHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "content-type": "application/json",
    "x-api-key": ADMIN_KEY,
    "x-treasury-actor": "tester",
    ...extra,
  };
}

describe("computeTpvContribution", () => {
  it("returns 5% of payment amount by default", () => {
    expect(computeTpvContribution(100)).toBeCloseTo(5, 6);
    expect(computeTpvContribution(0.1)).toBeCloseTo(0.005, 6);
  });

  it("returns 0 for non-positive inputs", () => {
    expect(computeTpvContribution(0)).toBe(0);
    expect(computeTpvContribution(-1)).toBe(0);
    expect(computeTpvContribution(Number.NaN)).toBe(0);
  });

  it("rejects out-of-range ratios", () => {
    expect(() => computeTpvContribution(100, -0.1)).toThrow();
    expect(() => computeTpvContribution(100, 1.5)).toThrow();
  });

  it("respects a custom ratio", () => {
    expect(computeTpvContribution(200, 0.025)).toBeCloseTo(5, 6);
  });
});

describe("TreasuryService", () => {
  let dbPath: string;

  beforeEach(() => {
    closeDatabase();
    dbPath = ":memory:";
  });

  afterEach(() => {
    closeDatabase();
  });

  it("summary starts empty when no payments or entries exist", () => {
    const db = openDatabase(dbPath);
    const treasury = new TreasuryService(db);
    const summary = treasury.getSummary();
    expect(summary.balanceUsdc).toBe(0);
    expect(summary.targetReserveUsdc).toBe(0);
    expect(summary.deficitUsdc).toBe(0);
    expect(summary.fullyFunded).toBe(true);
    expect(summary.reserveRatio).toBe(0.05);
  });

  it("records credits and debits with correct balance", () => {
    const db = openDatabase(dbPath);
    const treasury = new TreasuryService(db);

    treasury.recordCredit({
      amountUsdc: 100,
      reason: "manual_top_up",
      memo: "seed reserve",
      actor: "ops",
    });
    expect(treasury.getSummary().balanceUsdc).toBeCloseTo(100, 6);

    treasury.recordDebit({
      amountUsdc: 30,
      reason: "incident_refund",
      externalRef: "ticket-42",
      actor: "ops",
    });
    expect(treasury.getSummary().balanceUsdc).toBeCloseTo(70, 6);
  });

  it("rejects debit larger than current balance", () => {
    const db = openDatabase(dbPath);
    const treasury = new TreasuryService(db);

    treasury.recordCredit({
      amountUsdc: 10,
      reason: "manual_top_up",
      actor: "ops",
    });

    expect(() =>
      treasury.recordDebit({
        amountUsdc: 11,
        reason: "incident_refund",
        actor: "ops",
      }),
    ).toThrow(/insufficient/i);
  });

  it("rejects mismatched reason for credit/debit", () => {
    const db = openDatabase(dbPath);
    const treasury = new TreasuryService(db);
    expect(() =>
      treasury.recordCredit({
        amountUsdc: 1,
        reason: "incident_refund",
        actor: "x",
      } as Parameters<typeof treasury.recordCredit>[0]),
    ).toThrow(/must be recorded as a debit/);
    expect(() =>
      treasury.recordDebit({
        amountUsdc: 1,
        reason: "manual_top_up",
        actor: "x",
      } as Parameters<typeof treasury.recordDebit>[0]),
    ).toThrow(/must be recorded as a credit/);
  });

  it("recordTpvContribution is idempotent for the same payment id", () => {
    const db = openDatabase(dbPath);
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "ops@acme.test",
      webhookUrl: null,
    });
    insertPayment(db, {
      id: "pay_abc",
      merchantId: merchant.id,
      amountUsdc: 100,
      payerWallet: Keypair.generate().publicKey.toBase58(),
      metadata: null,
    });
    markPaymentCompleted(db, "pay_abc", "sig_abc");

    const treasury = new TreasuryService(db);
    const first = treasury.recordTpvContribution({
      paymentId: "pay_abc",
      paymentAmountUsdc: 100,
      merchantId: merchant.id,
    });
    const second = treasury.recordTpvContribution({
      paymentId: "pay_abc",
      paymentAmountUsdc: 100,
      merchantId: merchant.id,
    });
    expect(first).not.toBeNull();
    expect(second?.id).toBe(first?.id);
    expect(treasury.getSummary().balanceUsdc).toBeCloseTo(5, 6);
    expect(treasury.getSummary().completedTpvUsdc).toBeCloseTo(100, 6);
    expect(treasury.getSummary().targetReserveUsdc).toBeCloseTo(5, 6);
    expect(treasury.getSummary().fullyFunded).toBe(true);
  });
});

describe("treasury router", () => {
  let server: RunningServer;
  let url: string;

  beforeEach(async () => {
    closeDatabase();
    const db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: fakeSolana(),
      treasury: { adminKey: ADMIN_KEY },
    });
    server = await startApp(app);
    url = server.url;
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("rejects unauthenticated requests with 401", async () => {
    const res = await fetch(`${url}/treasury/reserve`);
    expect(res.status).toBe(401);
  });

  it("returns reserve summary for authenticated admin", async () => {
    const res = await fetch(`${url}/treasury/reserve`, {
      headers: buildAuthHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reserve: Record<string, unknown> };
    expect(body.reserve.reserveRatio).toBe(0.05);
    expect(body.reserve.balanceUsdc).toBe(0);
    expect(body.reserve.fullyFunded).toBe(true);
  });

  it("credits and lists entries, then debits within balance", async () => {
    const credit = await fetch(`${url}/treasury/reserve/credits`, {
      method: "POST",
      headers: buildAuthHeaders({ "Idempotency-Key": "credit-001" }),
      body: JSON.stringify({
        amountUsdc: 250,
        reason: "manual_top_up",
        memo: "initial seed",
      }),
    });
    expect(credit.status).toBe(201);
    const creditBody = (await credit.json()) as {
      reserve: { balanceUsdc: number };
    };
    expect(creditBody.reserve.balanceUsdc).toBeCloseTo(250, 6);

    const debit = await fetch(`${url}/treasury/reserve/debits`, {
      method: "POST",
      headers: buildAuthHeaders({ "Idempotency-Key": "debit-001" }),
      body: JSON.stringify({
        amountUsdc: 40,
        reason: "incident_refund",
        externalRef: "ticket-101",
      }),
    });
    expect(debit.status).toBe(201);
    const debitBody = (await debit.json()) as {
      reserve: { balanceUsdc: number };
    };
    expect(debitBody.reserve.balanceUsdc).toBeCloseTo(210, 6);

    const entries = await fetch(`${url}/treasury/reserve/entries`, {
      headers: buildAuthHeaders(),
    });
    expect(entries.status).toBe(200);
    const entriesBody = (await entries.json()) as {
      entries: Array<{ kind: string; reason: string }>;
    };
    expect(entriesBody.entries.length).toBe(2);
  });

  it("rejects credit with disallowed reason", async () => {
    const res = await fetch(`${url}/treasury/reserve/credits`, {
      method: "POST",
      headers: buildAuthHeaders({ "Idempotency-Key": "credit-bad-001" }),
      body: JSON.stringify({
        amountUsdc: 10,
        reason: "incident_refund",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 500 config_error when admin key is unset", async () => {
    await server.close();
    closeDatabase();
    const db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: fakeSolana(),
      treasury: { adminKey: null },
    });
    server = await startApp(app);
    const res = await fetch(`${server.url}/treasury/reserve`, {
      headers: { "x-api-key": "anything" },
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("config_error");
  });
});
