import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { findPaymentBySignature } from "../src/db/payments.js";
import { registerMerchant } from "../src/services/merchants.js";
import { EvmService } from "../src/services/evm.js";
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

// Solana stub — we only mount the EVM router but createApp still needs one.
function makeFakeSolana(): SolanaService {
  return {
    getPayerPublicKey: () => Keypair.generate().publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(),
  } as unknown as SolanaService;
}

const TEST_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // Hardhat account #1

interface StubOpts {
  fail?: boolean;
  insufficient?: boolean;
}

function makeEvmServiceWithStub(opts: StubOpts = {}): {
  evm: EvmService;
  txHash: `0x${string}`;
} {
  const txHash =
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;
  const evm = new EvmService({
    payerPrivateKey: TEST_PRIVATE_KEY,
    confirmations: 0,
    clientFactory: () => ({
      publicClient: {
        readContract: vi.fn(async () =>
          opts.insufficient ? 0n : 1_000_000_000n,
        ),
        waitForTransactionReceipt: vi.fn(async () => ({
          status: opts.fail ? ("reverted" as const) : ("success" as const),
        })),
      } as unknown as never,
      walletClient: {
        writeContract: vi.fn(async () => txHash),
      } as unknown as never,
    }),
  });
  return { evm, txHash };
}

describe("POST /pay/evm/:merchantRef", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(async () => {
    if (server) await server.close();
    closeDatabase();
  });

  it("transfers USDC on Base and persists payment with tx hash", async () => {
    const { evm, txHash } = makeEvmServiceWithStub();
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const recipient = "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc";
    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "base",
        amount: 12.5,
        recipientWallet: recipient,
        metadata: { invoice: "INV-1" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        id: string;
        status: string;
        txHash: string;
        txSignature: string;
        amount: number;
        amountUsdc: number;
        currency: string;
        chain: string;
        merchantId: string;
        metadata: Record<string, unknown>;
      };
      txHash: string;
      chainId: number;
      contractAddress: string;
    };
    expect(body.payment.status).toBe("completed");
    expect(body.payment.txHash).toBe(txHash);
    expect(body.payment.txSignature).toBe(txHash);
    expect(body.txHash).toBe(txHash);
    expect(body.chainId).toBe(8453);
    expect(body.contractAddress).toBe(
      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    );
    expect(body.payment.chain).toBe("base");
    expect(body.payment.currency).toBe("USDC");
    expect(body.payment.amount).toBe(12.5);
    expect(body.payment.merchantId).toBe(merchantId);
    expect(body.payment.metadata).toMatchObject({
      invoice: "INV-1",
      evm: { chain: "base", recipientWallet: recipient },
    });

    const persisted = findPaymentBySignature(db, txHash);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.chain).toBe("base");
  });

  it("accepts a bare merchantId (no @-prefix) for SDK ergonomics", async () => {
    const { evm } = makeEvmServiceWithStub();
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "polygon",
        amount: 1,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { chain: string };
      chainId: number;
    };
    expect(body.payment.chain).toBe("polygon");
    expect(body.chainId).toBe(137);
  });

  it("returns 404 when EVM service is not configured", async () => {
    const app = createApp({ db, solana: makeFakeSolana() });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "base",
        amount: 1,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("rejects unknown chain with 400", async () => {
    const { evm } = makeEvmServiceWithStub();
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "ethereum",
        amount: 1,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed recipient address with 400", async () => {
    const { evm } = makeEvmServiceWithStub();
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "base",
        amount: 1,
        recipientWallet: "not-an-address",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown merchant with 404", async () => {
    const { evm } = makeEvmServiceWithStub();
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@merch_does_not_exist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "base",
        amount: 1,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("marks payment failed when balance is insufficient", async () => {
    const { evm } = makeEvmServiceWithStub({ insufficient: true });
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "base",
        amount: 999,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("payment_failed");
  });

  it("marks payment failed when receipt is reverted", async () => {
    const { evm } = makeEvmServiceWithStub({ fail: true });
    const app = createApp({ db, solana: makeFakeSolana(), evm });
    server = await startApp(app);

    const res = await fetch(`${server.url}/pay/evm/@${merchantId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain: "polygon",
        amount: 1,
        recipientWallet: "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
      }),
    });
    expect(res.status).toBe(502);
  });
});
