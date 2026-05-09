import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import express from "express";
import request from "supertest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetConfigForTests } from "../src/config.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { createMerchantsRouter } from "../src/merchants/routes.js";
import { setMerchantStoreForTests, InMemoryMerchantStore } from "../src/merchants/store.js";
import { resetSolanaCache } from "../src/solana/connection.js";

vi.mock("../src/solana/ata.js", async () => {
  return {
    registerOnchainBinding: vi.fn(async (params: { merchantId: string; ownerWallet: { toBase58: () => string } }) => ({
      ataAddress: "AtaAddrMockMockMockMockMockMockMockMockMock",
      ataCreated: true,
      txSignature: "MockSignature1111111111111111111111111111111",
      memoPayload: JSON.stringify({ ns: "test", mid: params.merchantId, w: params.ownerWallet.toBase58() }),
      feePayer: "FeePayerMockMockMockMockMockMockMockMockMo",
    })),
  };
});

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/merchants", createMerchantsRouter());
  app.use(errorHandler);
  return app;
}

function freshWallet(): string {
  return new Keypair().publicKey.toBase58();
}

describe("POST /merchants/register", () => {
  beforeAll(() => {
    process.env.SOLANA_FEE_PAYER_SECRET = bs58.encode(Keypair.generate().secretKey);
    process.env.SOLANA_NETWORK = "devnet";
    resetConfigForTests();
    resetSolanaCache();
  });

  beforeEach(() => {
    setMerchantStoreForTests(new InMemoryMerchantStore());
  });

  afterEach(() => {
    setMerchantStoreForTests(null);
  });

  it("rejects invalid wallet pubkey", async () => {
    const res = await request(buildApp())
      .post("/merchants/register")
      .send({ name: "Acme", email: "a@b.co", walletAddress: "not-a-pubkey" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("validation_error");
  });

  it("rejects malformed body", async () => {
    const res = await request(buildApp())
      .post("/merchants/register")
      .send({ name: "X", email: "not-email", walletAddress: freshWallet() });
    expect(res.status).toBe(400);
  });

  it("registers a merchant and returns binding receipt", async () => {
    const wallet = freshWallet();
    const res = await request(buildApp())
      .post("/merchants/register")
      .send({ name: "Cafe Tatuapé", email: "lojista@tatuape.com.br", walletAddress: wallet });
    expect(res.status).toBe(201);
    expect(res.body.merchant.walletAddress).toBe(wallet);
    expect(res.body.merchant.status).toBe("active");
    expect(res.body.binding.ataAddress).toBe("AtaAddrMockMockMockMockMockMockMockMockMock");
    expect(res.body.binding.txSignature).toBe("MockSignature1111111111111111111111111111111");
    expect(res.body.apiKey).toMatch(/^zp_live_/);
  });

  it("rejects duplicate wallet", async () => {
    const wallet = freshWallet();
    await request(buildApp())
      .post("/merchants/register")
      .send({ name: "First", email: "first@x.com", walletAddress: wallet });
    const res = await request(buildApp())
      .post("/merchants/register")
      .send({ name: "Second", email: "second@x.com", walletAddress: wallet });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("conflict");
  });

  it("rejects duplicate email", async () => {
    await request(buildApp())
      .post("/merchants/register")
      .send({ name: "First", email: "shared@x.com", walletAddress: freshWallet() });
    const res = await request(buildApp())
      .post("/merchants/register")
      .send({ name: "Second", email: "shared@x.com", walletAddress: freshWallet() });
    expect(res.status).toBe(409);
  });
});
