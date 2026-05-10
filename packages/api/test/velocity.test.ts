import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { enforceVelocityLimits } from "../src/services/velocity.js";
import { findMerchantById, updateMerchantVelocity } from "../src/db/merchants.js";
import { insertPayment, markPaymentCompleted } from "../src/db/payments.js";
import type { SolanaService } from "../src/services/solana.js";
import { HttpError } from "../src/lib/errors.js";

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
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
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

describe("velocity service", () => {
  let db: Db;
  let merchantId: string;
  let payerWallet: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Velocity Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `v-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerWallet = Keypair.generate().publicKey.toBase58();
  });

  afterEach(() => {
    closeDatabase();
  });

  it("seeds defaults of 5 payments/min and $1000/hour on register", () => {
    const merchant = findMerchantById(db, merchantId)!;
    expect(merchant.velocity.maxPaymentsPerMinute).toBe(5);
    expect(merchant.velocity.maxAmountPerHour).toBe(1000);
  });

  it("allows under-limit payment counts", () => {
    const merchant = findMerchantById(db, merchantId)!;
    for (let i = 0; i < 4; i += 1) {
      const id = `pay_seed_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 10,
        payerWallet,
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_${i}`);
    }
    expect(() =>
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 10,
      }),
    ).not.toThrow();
  });

  it("rejects 6th payment from same wallet within 60s", () => {
    const merchant = findMerchantById(db, merchantId)!;
    for (let i = 0; i < 5; i += 1) {
      const id = `pay_burst_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1,
        payerWallet,
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_burst_${i}`);
    }
    let caught: HttpError | null = null;
    try {
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 1,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(429);
    expect(caught?.code).toBe("rate_limited");
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("velocity:per_wallet_per_minute");
  });

  it("rejects merchant exceeding $1000/hour cap", () => {
    const merchant = findMerchantById(db, merchantId)!;
    // Spread spend across multiple wallets so the per-wallet cap isn't tripped.
    const wallets = Array.from({ length: 5 }, () =>
      Keypair.generate().publicKey.toBase58(),
    );
    wallets.forEach((wallet, i) => {
      const id = `pay_spend_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 195,
        payerWallet: wallet,
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_spend_${i}`);
    });
    // Total spend = 5 * 195 = $975. Next $30 attempt would push to $1005 > $1000.
    let caught: HttpError | null = null;
    try {
      enforceVelocityLimits(db, {
        merchant,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 30,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(429);
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("velocity:per_merchant_per_hour");
  });

  it("ignores failed payments when counting velocity", () => {
    const merchant = findMerchantById(db, merchantId)!;
    // Insert 10 failed attempts — they must NOT consume budget.
    for (let i = 0; i < 10; i += 1) {
      const id = `pay_failed_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 100,
        payerWallet,
        metadata: null,
      });
      db.prepare(
        `UPDATE payments SET status = 'failed', error_message = 'rpc' WHERE id = ?`,
      ).run(id);
    }
    expect(() =>
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 100,
      }),
    ).not.toThrow();
  });

  it("ages out payments older than the window", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const oldIso = new Date(Date.now() - 3 * 60_000).toISOString();
    // Backdate 10 payments to 3 minutes ago — outside the 60s window.
    for (let i = 0; i < 10; i += 1) {
      const id = `pay_old_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 5,
        payerWallet,
        metadata: null,
      });
      db.prepare(
        `UPDATE payments SET status = 'completed', tx_signature = ?, created_at = ? WHERE id = ?`,
      ).run(`sig_old_${i}`, oldIso, id);
    }
    expect(() =>
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 5,
      }),
    ).not.toThrow();
  });

  it("respects per-merchant configured limits", () => {
    updateMerchantVelocity(db, merchantId, {
      maxPaymentsPerMinute: 2,
      maxAmountPerHour: 50,
    });
    const merchant = findMerchantById(db, merchantId)!;
    for (let i = 0; i < 2; i += 1) {
      const id = `pay_cfg_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 10,
        payerWallet,
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_cfg_${i}`);
    }
    expect(() =>
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 10,
      }),
    ).toThrow(HttpError);
  });

  it("treats 0 as disabling that cap", () => {
    updateMerchantVelocity(db, merchantId, {
      maxPaymentsPerMinute: 0,
      maxAmountPerHour: 1000,
    });
    const merchant = findMerchantById(db, merchantId)!;
    for (let i = 0; i < 50; i += 1) {
      const id = `pay_unbounded_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 1,
        payerWallet,
        metadata: null,
      });
      markPaymentCompleted(db, id, `sig_unbounded_${i}`);
    }
    expect(() =>
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: 1,
      }),
    ).not.toThrow();
  });
});

describe("PUT /merchants/:id/velocity", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Cfg Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `cfg-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("updates and persists velocity limits", async () => {
    const res = await fetch(`${server.url}/merchants/${merchantId}/velocity`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPaymentsPerMinute: 20, maxAmountPerHour: 5000 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { velocity: { maxPaymentsPerMinute: number; maxAmountPerHour: number } };
    };
    expect(body.merchant.velocity.maxPaymentsPerMinute).toBe(20);
    expect(body.merchant.velocity.maxAmountPerHour).toBe(5000);
    const persisted = findMerchantById(db, merchantId)!;
    expect(persisted.velocity.maxPaymentsPerMinute).toBe(20);
  });

  it("returns 404 for unknown merchant", async () => {
    const res = await fetch(`${server.url}/merchants/merch_nope/velocity`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPaymentsPerMinute: 5, maxAmountPerHour: 1000 }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects negative limits with 400", async () => {
    const res = await fetch(`${server.url}/merchants/${merchantId}/velocity`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPaymentsPerMinute: -1, maxAmountPerHour: 1000 }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects limits above the safety ceiling", async () => {
    const res = await fetch(`${server.url}/merchants/${merchantId}/velocity`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxPaymentsPerMinute: 5, maxAmountPerHour: 5_000_000 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /pay velocity integration", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Integ Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `integ-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerKp = Keypair.generate();
    const solana = makeFakeSolana(payerKp);
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("returns 429 on the 6th payment from the same wallet within 60s", async () => {
    const payerWallet = payerKp.publicKey.toBase58();
    for (let i = 0; i < 5; i += 1) {
      const ok = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amount: 1, payerWallet }),
      });
      expect(ok.status).toBe(201);
    }
    const sixth = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1, payerWallet }),
    });
    expect(sixth.status).toBe(429);
    const body = (await sixth.json()) as { error: { code: string } };
    expect(body.error.code).toBe("rate_limited");
  });
});
