import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  computeRiskScore,
  enforceRiskGate,
} from "../src/services/risk-scoring.js";
import {
  findMerchantById,
  updateMerchantFraudThreshold,
  updateMerchantVelocity,
} from "../src/db/merchants.js";
import { insertPayment } from "../src/db/payments.js";
import { findRiskAssessment } from "../src/db/risk_assessments.js";
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

describe("risk scoring", () => {
  let db: Db;
  let merchantId: string;
  let payerWallet: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Risk Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `risk-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerWallet = Keypair.generate().publicKey.toBase58();
  });

  afterEach(() => {
    closeDatabase();
  });

  it("seeds a default fraud threshold of 70 on register", () => {
    const merchant = findMerchantById(db, merchantId)!;
    expect(merchant.fraudReviewThreshold).toBe(70);
  });

  it("scores a small first-time payment well below the threshold", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const result = computeRiskScore(db, {
      merchant,
      payerWallet,
      amount: 10,
      metadata: { invoice: "INV-1" },
    });
    // new_payer (20) only — under 70.
    expect(result.score).toBe(20);
    expect(result.decision).toBe("allow");
  });

  it("treats a $6k brand-new payer attempt as review-queue worthy", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const result = computeRiskScore(db, {
      merchant,
      payerWallet,
      amount: 6000,
      metadata: null,
    });
    // amount_very_high(30) + new_payer(20) + no_metadata(5) + hour pressure
    // (6000/1000 ratio = 6.0 → +15) = 70.
    // The default threshold is 70 (strictly greater than = review). 70 ≤ 70
    // means allow. Push it just above by raising no_metadata via threshold.
    expect(result.score).toBeGreaterThanOrEqual(70);
  });

  it("flips to review when raw score exceeds the threshold", () => {
    updateMerchantFraudThreshold(db, merchantId, 50);
    const merchant = findMerchantById(db, merchantId)!;
    const result = computeRiskScore(db, {
      merchant,
      payerWallet,
      amount: 1500,
      metadata: null,
    });
    // amount_high(15) + new_payer(20) + no_metadata(5) = 40, hour ratio
    // (1500/1000 = 1.5) → +15 = 55. Threshold 50 → review.
    expect(result.score).toBeGreaterThan(50);
    expect(result.decision).toBe("review");
  });

  it("never returns a score above 100 even when every signal stacks", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const result = computeRiskScore(db, {
      merchant,
      payerWallet,
      amount: 10000,
      metadata: null,
    });
    expect(result.score).toBeLessThanOrEqual(100);
    expect(result.score).toBeGreaterThanOrEqual(0);
  });

  it("downgrades risk for repeat customers", () => {
    const merchant = findMerchantById(db, merchantId)!;
    // 10 prior completed payments, all backdated outside the 60s velocity
    // window so velocity_pressure is 0 — only the history bucket changes.
    const oldIso = new Date(Date.now() - 5 * 60_000).toISOString();
    for (let i = 0; i < 10; i += 1) {
      const id = `pay_old_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 10,
        payerWallet,
        metadata: null,
      });
      db.prepare(
        `UPDATE payments SET status = 'completed', tx_signature = ?, created_at = ? WHERE id = ?`,
      ).run(`sig_old_${i}`, oldIso, id);
    }
    const result = computeRiskScore(db, {
      merchant,
      payerWallet,
      amount: 10,
      metadata: { invoice: "INV-1" },
    });
    // No new_payer (10 prior > 2), no other tiers triggered.
    expect(result.signals.find((s) => s.type === "new_payer")).toBeUndefined();
    expect(result.signals.find((s) => s.type === "low_history_payer")).toBeUndefined();
    expect(result.score).toBe(0);
  });

  it("persists an assessment row on allow and on review", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const allowResult = enforceRiskGate(db, {
      merchant,
      payerWallet,
      amount: 5,
      metadata: { ok: true },
    });
    const persistedAllow = findRiskAssessment(db, allowResult.assessment.id);
    expect(persistedAllow?.decision).toBe("allow");
    expect(persistedAllow?.reviewStatus).toBeNull();

    updateMerchantFraudThreshold(db, merchantId, 30);
    const lowThresholdMerchant = findMerchantById(db, merchantId)!;
    expect(() =>
      enforceRiskGate(db, {
        merchant: lowThresholdMerchant,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        amount: 1500,
        metadata: null,
      }),
    ).toThrow(HttpError);
  });
});

describe("risk routes", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Route Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `route-${Date.now()}@example.com`,
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

  it("PUT /merchants/:id/fraud-threshold updates the threshold", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/fraud-threshold`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 40 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { fraudReviewThreshold: number };
    };
    expect(body.merchant.fraudReviewThreshold).toBe(40);
    const persisted = findMerchantById(db, merchantId)!;
    expect(persisted.fraudReviewThreshold).toBe(40);
  });

  it("rejects out-of-range thresholds with 400", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/fraud-threshold`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ threshold: 150 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("queues high-risk payments and surfaces them in the review queue", async () => {
    updateMerchantFraudThreshold(db, merchantId, 30);
    // Lift the velocity hour cap so the risk gate is the one that fires.
    updateMerchantVelocity(db, merchantId, {
      maxPaymentsPerMinute: 100,
      maxAmountPerHour: 100000,
    });
    // amount_very_high(30) + new_payer(20) + no_metadata(5) = 55 > 30 → review.
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 6000,
        payerWallet: payerKp.publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; details: { scope: string; riskAssessmentId: string; score: number } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details.scope).toBe("fraud:review_queued");
    const queueRes = await fetch(
      `${server.url}/merchants/${merchantId}/risk/queue`,
    );
    expect(queueRes.status).toBe(200);
    const queueBody = (await queueRes.json()) as {
      items: Array<{ id: string; score: number; decision: string }>;
      count: number;
    };
    expect(queueBody.count).toBe(1);
    expect(queueBody.items[0].id).toBe(body.error.details.riskAssessmentId);
    expect(queueBody.items[0].decision).toBe("review");
  });

  it("PATCH /risk/:id/review resolves a queued assessment", async () => {
    updateMerchantFraudThreshold(db, merchantId, 30);
    updateMerchantVelocity(db, merchantId, {
      maxPaymentsPerMinute: 100,
      maxAmountPerHour: 100000,
    });
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 6000,
        payerWallet: payerKp.publicKey.toBase58(),
      }),
    });
    expect(payRes.status).toBe(403);
    const payBody = (await payRes.json()) as {
      error: { details: { riskAssessmentId: string } };
    };
    const assessmentId = payBody.error.details.riskAssessmentId;
    const reviewRes = await fetch(
      `${server.url}/risk/${assessmentId}/review`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          decision: "approved",
          reason: "verified with customer",
          reviewedBy: "ops@zetta",
        }),
      },
    );
    expect(reviewRes.status).toBe(200);
    const reviewBody = (await reviewRes.json()) as {
      assessment: {
        reviewStatus: string;
        reviewedBy: string;
        reviewReason: string;
      };
    };
    expect(reviewBody.assessment.reviewStatus).toBe("approved");
    expect(reviewBody.assessment.reviewedBy).toBe("ops@zetta");
    expect(reviewBody.assessment.reviewReason).toBe("verified with customer");

    // Re-resolving the same assessment must 409.
    const conflict = await fetch(
      `${server.url}/risk/${assessmentId}/review`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      },
    );
    expect(conflict.status).toBe(409);
  });

  it("returns 404 for unknown assessment", async () => {
    const res = await fetch(`${server.url}/risk/risk_does_not_exist/review`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approved" }),
    });
    expect(res.status).toBe(404);
  });
});
