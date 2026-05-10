import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  findMerchantById,
  updateMerchantFraudBlockThreshold,
} from "../src/db/merchants.js";
import {
  insertPayment,
  markPaymentCompleted,
} from "../src/db/payments.js";
import { evaluatePaymentAnomalies } from "../src/services/anomaly.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { HttpError } from "../src/lib/errors.js";
import { staticGeoIpResolver, noopGeoIpResolver } from "../src/lib/geoip.js";

interface Seed {
  payerWallet: string;
  amount: number;
  country?: string | null;
  /** ISO timestamp override; if absent, db default ('now') applies. */
  createdAt?: string;
}

function seedHistory(
  db: Db,
  merchantId: string,
  seeds: Seed[],
): void {
  seeds.forEach((s, i) => {
    const id = `pay_seed_${i}_${Math.random().toString(36).slice(2, 8)}`;
    insertPayment(db, {
      id,
      merchantId,
      amountUsdc: s.amount,
      payerWallet: s.payerWallet,
      metadata: null,
      payerCountry: s.country ?? null,
    });
    markPaymentCompleted(db, id, `sig_${id}`);
    if (s.createdAt) {
      db.prepare(`UPDATE payments SET created_at = ? WHERE id = ?`).run(
        s.createdAt,
        id,
      );
    }
  });
}

describe("evaluatePaymentAnomalies (Z13.3)", () => {
  let db: Db;
  let merchantId: string;
  let payerWallet: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Anomaly Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `anom-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    payerWallet = Keypair.generate().publicKey.toBase58();
  });

  afterEach(() => {
    closeDatabase();
  });

  it("seeds fraud_block_threshold to 0 (monitor-only) on register", () => {
    const merchant = findMerchantById(db, merchantId)!;
    expect(merchant.fraudBlockThreshold).toBe(0);
  });

  it("returns score 0 with no signals when payer has no history", () => {
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 100,
      payerCountry: "US",
    });
    expect(evaluation.score).toBe(0);
    expect(evaluation.signals).toHaveLength(0);
    expect(evaluation.blocked).toBe(false);
  });

  it("flags an IP geolocation mismatch when country differs from history", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 50, country: "US" },
      { payerWallet, amount: 50, country: "US" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: "RU",
    });
    expect(evaluation.signals.map((s) => s.kind)).toContain(
      "ip_geolocation_mismatch",
    );
    expect(evaluation.score).toBeGreaterThanOrEqual(40);
  });

  it("does not flag IP mismatch for known countries", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 50, country: "US" },
      { payerWallet, amount: 50, country: "BR" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: "BR",
    });
    expect(evaluation.signals.map((s) => s.kind)).not.toContain(
      "ip_geolocation_mismatch",
    );
  });

  it("does not flag IP mismatch when current country is unknown (null)", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 50, country: "US" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: null,
    });
    expect(evaluation.signals.map((s) => s.kind)).not.toContain(
      "ip_geolocation_mismatch",
    );
  });

  it("flags amount z-score anomaly for an outlier amount", () => {
    // 10 prior payments around $10 → tiny mean, tiny stddev. $10000 is huge z.
    const seeds: Seed[] = Array.from({ length: 10 }, () => ({
      payerWallet,
      amount: 10 + Math.random() * 0.5,
      country: "US",
    }));
    seedHistory(db, merchantId, seeds);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 10_000,
      payerCountry: "US",
    });
    expect(evaluation.signals.map((s) => s.kind)).toContain(
      "amount_zscore_anomaly",
    );
  });

  it("does not flag z-score with too few baseline samples", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 10, country: "US" },
      { payerWallet, amount: 10, country: "US" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 10_000,
      payerCountry: "US",
    });
    expect(evaluation.signals.map((s) => s.kind)).not.toContain(
      "amount_zscore_anomaly",
    );
  });

  it("flags time-of-day anomaly when current hour is off-pattern", () => {
    // 12 prior payments all at 14:00 UTC. Current = 03:00 UTC (off-pattern).
    const seeds: Seed[] = Array.from({ length: 12 }, (_, i) => ({
      payerWallet,
      amount: 50,
      country: "US",
      createdAt: `2026-04-${String(10 + i).padStart(2, "0")}T14:30:00.000Z`,
    }));
    seedHistory(db, merchantId, seeds);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: "US",
      now: new Date("2026-05-01T03:15:00.000Z"),
    });
    expect(evaluation.signals.map((s) => s.kind)).toContain(
      "time_of_day_anomaly",
    );
  });

  it("does not flag time-of-day when current hour is in the active set", () => {
    const seeds: Seed[] = Array.from({ length: 12 }, (_, i) => ({
      payerWallet,
      amount: 50,
      country: "US",
      createdAt: `2026-04-${String(10 + i).padStart(2, "0")}T14:30:00.000Z`,
    }));
    seedHistory(db, merchantId, seeds);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: "US",
      now: new Date("2026-05-01T14:15:00.000Z"),
    });
    expect(evaluation.signals.map((s) => s.kind)).not.toContain(
      "time_of_day_anomaly",
    );
  });

  it("audits anomaly detection but does not block when threshold = 0", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 50, country: "US" },
      { payerWallet, amount: 50, country: "US" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    expect(merchant.fraudBlockThreshold).toBe(0);
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 50,
      payerCountry: "RU",
    });
    expect(evaluation.blocked).toBe(false);
    const audits = listAuditEntries(db, {
      event: "payment.anomaly_detected",
      entityType: "merchant",
      entityId: merchantId,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]?.payload).toMatchObject({ blocked: false });
  });

  it("blocks with 429 when score crosses configured threshold", () => {
    seedHistory(db, merchantId, [
      { payerWallet, amount: 50, country: "US" },
      { payerWallet, amount: 50, country: "US" },
    ]);
    updateMerchantFraudBlockThreshold(db, merchantId, 30);
    const merchant = findMerchantById(db, merchantId)!;
    let caught: HttpError | null = null;
    try {
      evaluatePaymentAnomalies(db, {
        merchant,
        payerWallet,
        amount: 50,
        payerCountry: "RU",
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(429);
    expect(caught?.code).toBe("rate_limited");
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("anomaly:fraud_block_threshold");
    const audits = listAuditEntries(db, {
      event: "payment.blocked.anomaly",
      entityType: "merchant",
      entityId: merchantId,
    });
    expect(audits).toHaveLength(1);
  });

  it("ignores failed payments when computing baselines", () => {
    // 10 failed thrash + 1 valid prior → only 1 baseline sample, below the
    // minimum of 5, so z-score should not fire.
    for (let i = 0; i < 10; i += 1) {
      const id = `pay_failed_${i}`;
      insertPayment(db, {
        id,
        merchantId,
        amountUsdc: 10,
        payerWallet,
        metadata: null,
        payerCountry: "US",
      });
      db.prepare(
        `UPDATE payments SET status = 'failed', error_message = 'rpc' WHERE id = ?`,
      ).run(id);
    }
    seedHistory(db, merchantId, [
      { payerWallet, amount: 10, country: "US" },
    ]);
    const merchant = findMerchantById(db, merchantId)!;
    const evaluation = evaluatePaymentAnomalies(db, {
      merchant,
      payerWallet,
      amount: 10_000,
      payerCountry: "US",
    });
    expect(evaluation.signals.map((s) => s.kind)).not.toContain(
      "amount_zscore_anomaly",
    );
    expect(evaluation.baselineSize).toBe(1);
  });
});

describe("geoip resolvers", () => {
  it("noopGeoIpResolver returns null for any IP", () => {
    expect(noopGeoIpResolver("1.2.3.4")).toBeNull();
    expect(noopGeoIpResolver(null)).toBeNull();
    expect(noopGeoIpResolver("")).toBeNull();
  });

  it("staticGeoIpResolver maps known IPs and returns null for misses", () => {
    const resolver = staticGeoIpResolver({ "1.2.3.4": "US", "5.6.7.8": "BR" });
    expect(resolver("1.2.3.4")).toBe("US");
    expect(resolver("5.6.7.8")).toBe("BR");
    expect(resolver("9.9.9.9")).toBeNull();
    expect(resolver(null)).toBeNull();
  });
});
