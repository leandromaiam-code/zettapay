import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { generateKeyPairSync, sign as cryptoSign, type KeyObject } from "node:crypto";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { findMerchantById } from "../src/db/merchants.js";
import { findPaymentById } from "../src/db/payments.js";
import { findRefundByPaymentId } from "../src/db/refunds.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import {
  buildRefundIntentMessage,
  type RefundIntent,
} from "../src/lib/refund-auth.js";
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

interface MerchantWallet {
  publicKey: string;
  privateKey: KeyObject;
}

function makeMerchantWallet(): MerchantWallet {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

function signIntent(intent: RefundIntent, privateKey: KeyObject): string {
  const message = buildRefundIntentMessage(intent);
  return bs58.encode(cryptoSign(null, message, privateKey));
}

function makeFakeSolana(payerKp: Keypair, opts: { fail?: boolean } = {}): SolanaService {
  const transferToken = vi.fn(
    async (params: {
      recipientOwner: PublicKey;
      amount: number;
      currency?: "USDC" | "USDT" | "EURC" | "PYUSD";
    }) => {
      if (opts.fail) {
        throw new Error("simulated chain failure");
      }
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
  );
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken,
  } as unknown as SolanaService;
}

describe("POST /refund/:paymentId", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let merchantApiKey: string;
  let merchantWallet: MerchantWallet;
  let payerKp: Keypair;

  async function createPayment(amount = 12.5, currency = "USDC"): Promise<string> {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount, currency }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { payment: { id: string } };
    return body.payment.id;
  }

  function intentFor(paymentId: string, overrides: Partial<RefundIntent> = {}): RefundIntent {
    return {
      paymentId,
      merchantWallet: merchantWallet.publicKey,
      amount: 12.5,
      currency: "USDC",
      reason: "duplicate charge",
      issuedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  async function postRefund(
    paymentId: string,
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${server.url}/refund/${paymentId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchantApiKey,
        ...headers,
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    merchantWallet = makeMerchantWallet();
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: merchantWallet.publicKey,
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    merchantApiKey = merchant.apiKey;
    const app = createApp({ db, solana: makeFakeSolana(payerKp) });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("refunds a completed payment with a valid signed merchant approval", async () => {
    const paymentId = await createPayment(12.5);
    const intent = intentFor(paymentId);
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      refund: {
        id: string;
        paymentId: string;
        status: string;
        txHash: string;
        txSignature: string;
        signedBy: string;
        reason: string;
      };
      payment: { status: string };
    };
    expect(body.refund.paymentId).toBe(paymentId);
    expect(body.refund.status).toBe("completed");
    expect(body.refund.txHash).toMatch(/^sig_USDC_/);
    expect(body.refund.txSignature).toBe(body.refund.txHash);
    expect(body.refund.signedBy).toBe(merchantWallet.publicKey);
    expect(body.refund.reason).toBe("duplicate charge");
    expect(body.payment.status).toBe("refunded");

    // Persistence: payment row flipped, refund row recorded.
    expect(findPaymentById(db, paymentId)?.status).toBe("refunded");
    const persisted = findRefundByPaymentId(db, paymentId);
    expect(persisted?.status).toBe("completed");
    expect(persisted?.signature).toBe(signature);

    // Audit: a payment.refunded entry references the payment.
    const audit = listAuditEntries(db, {
      event: "payment.refunded",
      entityId: paymentId,
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]?.actor).toBe(`merchant:${merchantId}`);
    expect(audit[0]?.reason).toBe("duplicate charge");
  });

  it("returns the existing refund row on a second call (idempotent for completed refunds)", async () => {
    const paymentId = await createPayment(12.5);
    const intent = intentFor(paymentId);
    const signature = signIntent(intent, merchantWallet.privateKey);

    const first = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { refund: { id: string } };

    // Re-sign with a fresh issuedAt so the new signature is independent — the
    // service should still short-circuit because the refund already completed.
    const intent2 = intentFor(paymentId, {
      issuedAt: new Date().toISOString(),
    });
    const second = await postRefund(paymentId, {
      amount: intent2.amount,
      reason: intent2.reason,
      issuedAt: intent2.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature: signIntent(intent2, merchantWallet.privateKey),
    });
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { refund: { id: string } };
    expect(secondBody.refund.id).toBe(firstBody.refund.id);
  });

  it("rejects when the signed amount does not match the payment amount (V1: full refund only)", async () => {
    const paymentId = await createPayment(12.5);
    const intent = intentFor(paymentId, { amount: 5 });
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("validation_error");
  });

  it("rejects a signature from an attacker wallet even with a valid API key", async () => {
    const paymentId = await createPayment(12.5);
    const attacker = makeMerchantWallet();
    const intent = intentFor(paymentId, { merchantWallet: attacker.publicKey });
    const signature = signIntent(intent, attacker.privateKey);

    const res = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: attacker.publicKey,
      signature,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
    // Payment must NOT have flipped to refunded.
    expect(findPaymentById(db, paymentId)?.status).toBe("completed");
    expect(findRefundByPaymentId(db, paymentId)).toBeNull();
  });

  it("rejects a request without an API key (401)", async () => {
    const paymentId = await createPayment(12.5);
    const intent = intentFor(paymentId);
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await fetch(`${server.url}/refund/${paymentId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        amount: intent.amount,
        reason: intent.reason,
        issuedAt: intent.issuedAt,
        publicKey: merchantWallet.publicKey,
        signature,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects when the issuedAt is outside the replay window", async () => {
    const paymentId = await createPayment(12.5);
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const intent = intentFor(paymentId, { issuedAt: stale });
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string; details?: { code: string } } };
    expect(body.error.code).toBe("unauthorized");
    expect(body.error.details?.code).toBe("issued_at_expired");
  });

  it("returns 404 for a payment that belongs to a different merchant", async () => {
    const paymentId = await createPayment(12.5);
    // Register a second merchant; their API key cannot reach the first
    // merchant's payment.
    const otherMerchant = registerMerchant(db, {
      name: "Other",
      walletAddress: makeMerchantWallet().publicKey,
      email: `other-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    const intent = intentFor(paymentId);
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await fetch(`${server.url}/refund/${paymentId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": otherMerchant.apiKey,
      },
      body: JSON.stringify({
        amount: intent.amount,
        reason: intent.reason,
        issuedAt: intent.issuedAt,
        publicKey: merchantWallet.publicKey,
        signature,
      }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for an unknown payment id", async () => {
    const intent = intentFor("pay_does_not_exist");
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await postRefund("pay_does_not_exist", {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });
    expect(res.status).toBe(404);
  });

  it("rolls back to status=failed when the on-chain reversal fails, leaving payment intact", async () => {
    // Re-create the app with a Solana mock that throws.
    await server.close();
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    merchantWallet = makeMerchantWallet();
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: merchantWallet.publicKey,
      email: `merchant-${Date.now()}-fail@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    merchantApiKey = merchant.apiKey;

    // First payment must succeed (regular fake), then we swap in a failing
    // fake by creating a router that uses a single transferToken hook for
    // both flows. Easiest: use a fake that succeeds for the first call and
    // fails for the second. We accomplish this by counting calls.
    let callCount = 0;
    const conditionalSolana = {
      getPayerPublicKey: () => payerKp.publicKey,
      getCluster: () => "devnet" as const,
      getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      transferToken: vi.fn(
        async (params: { recipientOwner: PublicKey; amount: number; currency?: string }) => {
          callCount++;
          if (callCount > 1) throw new Error("simulated chain failure");
          return {
            signature: `sig_USDC_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}`,
            payerWallet: payerKp.publicKey.toBase58(),
            recipientWallet: params.recipientOwner.toBase58(),
            amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
            decimals: 6,
            currency: "USDC",
            mintAddress: "mint_USDC",
          };
        },
      ),
    } as unknown as SolanaService;
    const app = createApp({ db, solana: conditionalSolana });
    server = await startApp(app);

    const paymentId = await createPayment(12.5);
    const intent = intentFor(paymentId);
    const signature = signIntent(intent, merchantWallet.privateKey);

    const res = await postRefund(paymentId, {
      amount: intent.amount,
      reason: intent.reason,
      issuedAt: intent.issuedAt,
      publicKey: merchantWallet.publicKey,
      signature,
    });
    expect(res.status).toBe(502);
    const refund = findRefundByPaymentId(db, paymentId);
    expect(refund?.status).toBe("failed");
    expect(refund?.errorMessage).toContain("simulated chain failure");
    // Payment was not flipped.
    expect(findPaymentById(db, paymentId)?.status).toBe("completed");
    expect(findMerchantById(db, merchantId)).not.toBeNull();
  });
});
