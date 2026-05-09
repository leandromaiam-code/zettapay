import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import type { SolanaService } from "../src/services/solana.js";
import { findPaymentBySignature } from "../src/db/payments.js";

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

function makeFakeSolana(payerKp: Keypair, opts: { fail?: boolean } = {}): SolanaService {
  const svc = {
    getPayerPublicKey: () => payerKp.publicKey,
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferUsdc: vi.fn(async (params: { recipientOwner: PublicKey; amountUsdc: number }) => {
      if (opts.fail) {
        throw new Error("simulated rpc failure");
      }
      return {
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amountUsdc}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amountUsdc * 1_000_000)),
        decimals: 6,
      };
    }),
  } as unknown as SolanaService;
  return svc;
}

describe("POST /pay", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const solana = makeFakeSolana(payerKp);
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("transfers USDC and persists payment with tx signature", async () => {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 12.5, metadata: { invoice: "INV-1" } }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        id: string;
        status: string;
        txSignature: string;
        amountUsdc: number;
        merchantId: string;
        metadata: Record<string, unknown>;
      };
      txSignature: string;
    };
    expect(body.payment.status).toBe("completed");
    expect(body.payment.txSignature).toMatch(/^sig_/);
    expect(body.txSignature).toBe(body.payment.txSignature);
    expect(body.payment.amountUsdc).toBe(12.5);
    expect(body.payment.merchantId).toBe(merchantId);
    expect(body.payment.metadata).toEqual({ invoice: "INV-1" });

    const persisted = findPaymentBySignature(db, body.payment.txSignature);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.merchantId).toBe(merchantId);
  });

  it("rejects unknown merchant with 404", async () => {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId: "merch_does_not_exist", amountUsdc: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects non-positive amount with 400", async () => {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("marks payment failed when solana transfer throws", async () => {
    const failingSolana = makeFakeSolana(payerKp, { fail: true });
    const app = createApp({ db, solana: failingSolana });
    const failServer = await startApp(app);
    try {
      const res = await fetch(`${failServer.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amountUsdc: 1 }),
      });
      expect(res.status).toBe(502);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe("payment_failed");
    } finally {
      await failServer.close();
    }
  });
});
