import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
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
  const svc = {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: (currency = "USDC") =>
      currency === "USDC"
        ? "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
        : `mint_${currency}`,
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(
      async (params: {
        recipientOwner: PublicKey;
        amount: number;
        currency?: "USDC" | "USDT" | "EURC" | "PYUSD";
      }) => {
        const currency = params.currency ?? "USDC";
        return {
          signature: `sig_${currency}_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}`,
          payerWallet: payerKp.publicKey.toBase58(),
          recipientWallet: params.recipientOwner.toBase58(),
          amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
          decimals: 6,
          currency,
          mintAddress: `mint_${currency}`,
        };
      },
    ),
  } as unknown as SolanaService;
  return svc;
}

interface UnifiedPaymentBody {
  payment: {
    id: string;
    merchantId: string;
    chain: string;
    currency: string;
    amount: number;
    amountUsdc: number;
    status: string;
    payerWallet: string;
    txHash: string | null;
    txSignature: string | null;
    metadata: Record<string, unknown>;
    agentIdentityId: string | null;
    errorMessage: string | null;
    createdAt: string;
    completedAt: string | null;
  };
}

describe("GET /payment/:id (unified)", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const payerKp = Keypair.generate();
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const app = createApp({ db, solana: makeFakeSolana(payerKp) });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  async function createPayment(amount: number, currency = "USDC"): Promise<string> {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount,
        currency,
        metadata: { invoice: "INV-99" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment: { id: string } };
    return body.payment.id;
  }

  it("returns the unified payment shape with chain, txHash and amount aliases", async () => {
    const id = await createPayment(7.25);

    const res = await fetch(`${server.url}/payment/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnifiedPaymentBody;
    expect(body.payment.id).toBe(id);
    expect(body.payment.merchantId).toBe(merchantId);
    expect(body.payment.chain).toBe("solana");
    expect(body.payment.currency).toBe("USDC");
    expect(body.payment.amount).toBe(7.25);
    expect(body.payment.amountUsdc).toBe(7.25);
    expect(body.payment.status).toBe("completed");
    // txHash is the chain-agnostic alias for txSignature.
    expect(body.payment.txHash).toBe(body.payment.txSignature);
    expect(body.payment.txHash).toMatch(/^sig_USDC_/);
    expect(body.payment.metadata).toEqual({ invoice: "INV-99" });
    expect(body.payment.errorMessage).toBeNull();
    expect(typeof body.payment.createdAt).toBe("string");
  });

  it("returns the same shape for non-default currencies", async () => {
    const id = await createPayment(3, "EURC");

    const res = await fetch(`${server.url}/payment/${id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UnifiedPaymentBody;
    // Same envelope, different currency: contract is chain-agnostic and
    // currency-agnostic — clients render it identically regardless.
    expect(body.payment.chain).toBe("solana");
    expect(body.payment.currency).toBe("EURC");
    expect(body.payment.amount).toBe(3);
    expect(body.payment.txHash).toMatch(/^sig_EURC_/);
  });

  it("404s on unknown payment id", async () => {
    const res = await fetch(`${server.url}/payment/pay_does_not_exist`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("rejects oversized id with 400", async () => {
    const longId = "p".repeat(65);
    const res = await fetch(`${server.url}/payment/${longId}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });
});
