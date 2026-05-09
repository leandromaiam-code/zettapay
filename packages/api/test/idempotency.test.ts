import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import express from "express";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import type { SolanaService } from "../src/services/solana.js";
import { registerMerchant } from "../src/services/merchants.js";

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

function makeFakeSolana(): {
  service: SolanaService;
  transferToken: ReturnType<typeof vi.fn>;
} {
  const payerKp = Keypair.generate();
  const transferToken = vi.fn(
    async (params: {
      recipientOwner: PublicKey;
      amount: number;
      currency?: "USDC" | "USDT" | "EURC" | "PYUSD";
    }) => {
      const currency = params.currency ?? "USDC";
      return {
        signature: `sig_${Math.random().toString(36).slice(2, 10)}_${params.amount}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
        currency,
        mintAddress: `mint_${currency}`,
      };
    },
  );
  const service = {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken,
  } as unknown as SolanaService;
  return { service, transferToken };
}

describe("idempotency middleware", () => {
  let db: Db;
  let server: RunningServer;
  let transferToken: ReturnType<typeof vi.fn>;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const fake = makeFakeSolana();
    transferToken = fake.transferToken;
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const app = createApp({ db, solana: fake.service });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  describe("POST /pay", () => {
    it("replays the cached response when the same key + body is reused", async () => {
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "pay-key-aaaaaaaa-1111",
      };
      const body = JSON.stringify({ merchantId, amountUsdc: 5 });

      const first = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { payment: { id: string; txSignature: string } };

      const second = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body,
      });
      expect(second.status).toBe(201);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      const secondBody = (await second.json()) as { payment: { id: string; txSignature: string } };
      expect(secondBody.payment.id).toBe(firstBody.payment.id);
      expect(secondBody.payment.txSignature).toBe(firstBody.payment.txSignature);

      expect(transferToken).toHaveBeenCalledTimes(1);
    });

    it("returns 409 when the same key is reused with a different body", async () => {
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "pay-key-aaaaaaaa-2222",
      };
      const first = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body: JSON.stringify({ merchantId, amountUsdc: 5 }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body: JSON.stringify({ merchantId, amountUsdc: 6 }),
      });
      expect(second.status).toBe(409);
      const body = (await second.json()) as { error: { code: string } };
      expect(body.error.code).toBe("conflict");
      expect(transferToken).toHaveBeenCalledTimes(1);
    });

    it("processes both calls when no Idempotency-Key is sent", async () => {
      const headers = { "content-type": "application/json" };
      const body = JSON.stringify({ merchantId, amountUsdc: 5 });
      const first = await fetch(`${server.url}/pay`, { method: "POST", headers, body });
      expect(first.status).toBe(201);
      const second = await fetch(`${server.url}/pay`, { method: "POST", headers, body });
      expect(second.status).toBe(201);
      expect(transferToken).toHaveBeenCalledTimes(2);
    });

    it("rejects malformed Idempotency-Key headers with 400", async () => {
      const res = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "short",
        },
        body: JSON.stringify({ merchantId, amountUsdc: 1 }),
      });
      expect(res.status).toBe(400);
      expect(transferToken).not.toHaveBeenCalled();
    });

    it("does not cache failed (5xx) responses — caller can retry", async () => {
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "pay-key-aaaaaaaa-3333",
      };
      // unknown merchant → 404, must NOT be cached as a successful replay
      const first = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body: JSON.stringify({ merchantId: "merch_does_not_exist", amountUsdc: 1 }),
      });
      expect(first.status).toBe(404);

      const second = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers,
        body: JSON.stringify({ merchantId, amountUsdc: 1 }),
      });
      // Same key, different (this time valid) body → no cached row, so it proceeds
      expect(second.status).toBe(201);
    });
  });

  describe("POST /merchants/register", () => {
    it("replays the cached merchant on duplicate Idempotency-Key", async () => {
      const wallet = Keypair.generate().publicKey.toBase58();
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "merch-key-bbbbbbbb-1111",
      };
      const body = JSON.stringify({
        name: "Acme",
        walletAddress: wallet,
        email: "owner@acme.test",
      });

      const first = await fetch(`${server.url}/merchants/register`, {
        method: "POST",
        headers,
        body,
      });
      expect(first.status).toBe(201);
      const firstBody = (await first.json()) as { merchant: { id: string } };

      const second = await fetch(`${server.url}/merchants/register`, {
        method: "POST",
        headers,
        body,
      });
      expect(second.status).toBe(201);
      expect(second.headers.get("idempotent-replayed")).toBe("true");
      const secondBody = (await second.json()) as { merchant: { id: string } };
      expect(secondBody.merchant.id).toBe(firstBody.merchant.id);
    });

    it("rejects key reuse with a different request body", async () => {
      const headers = {
        "content-type": "application/json",
        "idempotency-key": "merch-key-bbbbbbbb-2222",
      };
      const first = await fetch(`${server.url}/merchants/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Acme",
          walletAddress: Keypair.generate().publicKey.toBase58(),
          email: "first@acme.test",
        }),
      });
      expect(first.status).toBe(201);

      const second = await fetch(`${server.url}/merchants/register`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name: "Acme",
          walletAddress: Keypair.generate().publicKey.toBase58(),
          email: "second@acme.test",
        }),
      });
      expect(second.status).toBe(409);
    });
  });
});
