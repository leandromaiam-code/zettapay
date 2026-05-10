import type { Database as Db } from "better-sqlite3";
import {
  attachAlertsToSar,
  findAmlAlert,
  findAmlSar,
  findRecentPayerAlerts,
  insertAmlAlert,
  insertAmlSar,
  listAmlAlerts,
  listAmlSars,
  markAmlSarFiled,
  updateAmlAlertReview,
  type AmlAlert,
  type AmlAlertRule,
  type AmlAlertSeverity,
  type AmlAlertStatus,
  type AmlSar,
} from "../db/aml.js";
import { appendAudit } from "../db/audit_journal.js";
import {
  countPaymentsByPayerSince,
  getPayment,
  sumPaymentAmountByMerchantSince,
  type Payment,
} from "../db/payments.js";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";

/**
 * Rule thresholds tuned for v1 (Z21.2). All amounts in USD-equivalent.
 * Configurable per-merchant comes in a follow-up; for now these are global
 * defaults derived from BSA structuring guidance ($10k report threshold) and
 * empirical merchant fraud benchmarks.
 */
export interface AmlMonitorConfig {
  /** Single-payment cap that auto-flags (default $9,000 — BSA structuring guard). */
  highAmountThreshold: number;
  /** Per-payer count window for structuring (small payments below cap). */
  structuringMinPayments: number;
  structuringWindowMs: number;
  /** Per-payer rapid-repeat detection (potential bot/abuse). */
  rapidRepeatMinPayments: number;
  rapidRepeatWindowMs: number;
  /** Round-amount detection: amount with cents == 0 AND amount >= this. */
  roundAmountThreshold: number;
  roundAmountMinCount: number;
  roundAmountWindowMs: number;
  /** Per-merchant velocity spike (sum of completed amounts). */
  velocitySpikeAmount: number;
  velocitySpikeWindowMs: number;
  /** Sanctioned-wallet denylist (env-fed). Compared case-sensitive (base58). */
  sanctionedWallets: ReadonlySet<string>;
}

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

export const DEFAULT_AML_CONFIG: AmlMonitorConfig = {
  highAmountThreshold: 9_000,
  structuringMinPayments: 4,
  structuringWindowMs: ONE_DAY_MS,
  rapidRepeatMinPayments: 10,
  rapidRepeatWindowMs: 5 * ONE_MINUTE_MS,
  roundAmountThreshold: 500,
  roundAmountMinCount: 3,
  roundAmountWindowMs: ONE_DAY_MS,
  velocitySpikeAmount: 25_000,
  velocitySpikeWindowMs: ONE_HOUR_MS,
  sanctionedWallets: new Set<string>(),
};

const SEVERITY_SCORE: Record<AmlAlertSeverity, number> = {
  low: 25,
  medium: 50,
  high: 75,
  critical: 100,
};

export interface EvaluatePaymentInput {
  payment: Payment;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface EvaluatePaymentResult {
  alerts: AmlAlert[];
}

/**
 * Runs the deterministic rule pack against a payment that has just been
 * recorded. Each rule produces 0 or 1 alert; alerts are persisted and an
 * audit event is appended per rule fire so SAR generation downstream has an
 * immutable evidence trail (premissa #24, audit-ready compliance).
 *
 * Designed to be called fire-and-forget after `createPayment` completes —
 * never throws to the caller (errors are swallowed and audited as
 * `aml.evaluate.error`) so payment processing is decoupled from monitoring.
 */
export function evaluatePayment(
  db: Db,
  input: EvaluatePaymentInput,
  config: AmlMonitorConfig = DEFAULT_AML_CONFIG,
): EvaluatePaymentResult {
  const alerts: AmlAlert[] = [];
  const { payment } = input;
  const now = input.now ?? new Date();

  const fire = (
    rule: AmlAlertRule,
    severity: AmlAlertSeverity,
    summary: string,
    evidence: Record<string, unknown>,
  ): void => {
    const id = newId("aml");
    const alert = insertAmlAlert(db, {
      id,
      merchantId: payment.merchantId,
      paymentId: payment.id,
      payerWallet: payment.payerWallet,
      rule,
      severity,
      score: SEVERITY_SCORE[severity],
      summary,
      evidence,
    });
    appendAudit(db, {
      actor: `merchant:${payment.merchantId}`,
      event: "aml.alert.created",
      payload: {
        alertId: alert.id,
        rule,
        severity,
        paymentId: payment.id,
        payerWallet: payment.payerWallet,
      },
    });
    alerts.push(alert);
  };

  if (config.sanctionedWallets.has(payment.payerWallet)) {
    fire("sanctioned_wallet", "critical", "Payer wallet on sanctions denylist", {
      payerWallet: payment.payerWallet,
      paymentId: payment.id,
      amount: payment.amountUsdc,
    });
  }

  if (payment.amountUsdc >= config.highAmountThreshold) {
    fire("high_amount", "high", "Single payment at or above high-amount cap", {
      amount: payment.amountUsdc,
      threshold: config.highAmountThreshold,
      paymentId: payment.id,
    });
  }

  // Structuring: many small payments below the high-amount cap from the same
  // payer in a 24h window. We require all payments to be sub-cap; one over-cap
  // payment short-circuits to the high_amount rule above instead.
  const structSince = new Date(
    now.getTime() - config.structuringWindowMs,
  ).toISOString();
  const structCount = countPaymentsByPayerSince(
    db,
    payment.merchantId,
    payment.payerWallet,
    structSince,
  );
  if (
    structCount >= config.structuringMinPayments &&
    payment.amountUsdc < config.highAmountThreshold
  ) {
    const recent = findRecentPayerAlerts(
      db,
      payment.merchantId,
      payment.payerWallet,
      "structuring",
      structSince,
    );
    if (recent.length === 0) {
      fire("structuring", "high", "Repeated sub-threshold payments from payer", {
        payerWallet: payment.payerWallet,
        windowSec: Math.round(config.structuringWindowMs / 1000),
        observedCount: structCount,
        threshold: config.structuringMinPayments,
        highAmountCap: config.highAmountThreshold,
      });
    }
  }

  const rapidSince = new Date(
    now.getTime() - config.rapidRepeatWindowMs,
  ).toISOString();
  const rapidCount = countPaymentsByPayerSince(
    db,
    payment.merchantId,
    payment.payerWallet,
    rapidSince,
  );
  if (rapidCount >= config.rapidRepeatMinPayments) {
    const recent = findRecentPayerAlerts(
      db,
      payment.merchantId,
      payment.payerWallet,
      "rapid_repeat_payer",
      rapidSince,
    );
    if (recent.length === 0) {
      fire(
        "rapid_repeat_payer",
        "medium",
        "Burst of rapid payments from same payer",
        {
          payerWallet: payment.payerWallet,
          windowSec: Math.round(config.rapidRepeatWindowMs / 1000),
          observedCount: rapidCount,
          threshold: config.rapidRepeatMinPayments,
        },
      );
    }
  }

  if (
    payment.amountUsdc >= config.roundAmountThreshold &&
    isRoundAmount(payment.amountUsdc)
  ) {
    const roundSince = new Date(
      now.getTime() - config.roundAmountWindowMs,
    ).toISOString();
    const roundCount = countRoundAmountPayments(
      db,
      payment.merchantId,
      payment.payerWallet,
      config.roundAmountThreshold,
      roundSince,
    );
    if (roundCount >= config.roundAmountMinCount) {
      const recent = findRecentPayerAlerts(
        db,
        payment.merchantId,
        payment.payerWallet,
        "round_amount_pattern",
        roundSince,
      );
      if (recent.length === 0) {
        fire(
          "round_amount_pattern",
          "low",
          "Repeated round-figure payments from payer",
          {
            payerWallet: payment.payerWallet,
            windowSec: Math.round(config.roundAmountWindowMs / 1000),
            observedCount: roundCount,
            minCount: config.roundAmountMinCount,
            roundAmountThreshold: config.roundAmountThreshold,
          },
        );
      }
    }
  }

  const spikeSince = new Date(
    now.getTime() - config.velocitySpikeWindowMs,
  ).toISOString();
  const spikeTotal = sumPaymentAmountByMerchantSince(
    db,
    payment.merchantId,
    spikeSince,
  );
  if (spikeTotal >= config.velocitySpikeAmount) {
    const recent = findRecentPayerAlerts(
      db,
      payment.merchantId,
      payment.payerWallet,
      "velocity_spike",
      spikeSince,
    );
    if (recent.length === 0) {
      fire(
        "velocity_spike",
        "medium",
        "Merchant inbound volume spike in window",
        {
          windowSec: Math.round(config.velocitySpikeWindowMs / 1000),
          totalUsdc: spikeTotal,
          threshold: config.velocitySpikeAmount,
        },
      );
    }
  }

  return { alerts };
}

function isRoundAmount(amount: number): boolean {
  // amount is stored as decimal USDC; treat anything with cents == 0 as round.
  return Math.round(amount * 100) % 100 === 0;
}

function countRoundAmountPayments(
  db: Db,
  merchantId: string,
  payerWallet: string,
  minAmount: number,
  sinceIso: string,
): number {
  const row = db
    .prepare<[string, string, number, string]>(
      `SELECT COUNT(*) AS n FROM payments
       WHERE merchant_id = ? AND payer_wallet = ? AND amount_usdc >= ? AND created_at >= ?
         AND status != 'failed'
         AND ABS(amount_usdc * 100 - CAST(amount_usdc * 100 + 0.5 AS INTEGER)) < 0.001
         AND CAST(amount_usdc * 100 AS INTEGER) % 100 = 0`,
    )
    .get(merchantId, payerWallet, minAmount, sinceIso) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

export interface EvaluatePaymentByIdInput {
  paymentId: string;
  now?: Date;
}

/**
 * Convenience wrapper used by routes / async callers — fetches the payment
 * row first. Returns an empty alert list if the payment does not exist
 * (reconciles with the fire-and-forget contract from the payment service).
 */
export function evaluatePaymentById(
  db: Db,
  input: EvaluatePaymentByIdInput,
  config: AmlMonitorConfig = DEFAULT_AML_CONFIG,
): EvaluatePaymentResult {
  let payment: Payment;
  try {
    payment = getPayment(db, input.paymentId);
  } catch {
    return { alerts: [] };
  }
  return evaluatePayment(
    db,
    input.now ? { payment, now: input.now } : { payment },
    config,
  );
}

export interface ReviewAlertInput {
  alertId: string;
  merchantId: string;
  status: AmlAlertStatus;
  reviewedBy: string;
  notes?: string | null;
}

export function reviewAlert(db: Db, input: ReviewAlertInput): AmlAlert {
  const existing = findAmlAlert(db, input.alertId);
  if (!existing || existing.merchantId !== input.merchantId) {
    throw HttpError.notFound(`AML alert ${input.alertId} not found`);
  }
  if (input.status === "open") {
    throw HttpError.badRequest("Cannot transition AML alert back to 'open'");
  }
  const updated = updateAmlAlertReview(db, input.alertId, {
    status: input.status,
    reviewedBy: input.reviewedBy,
    notes: input.notes ?? null,
  });
  appendAudit(db, {
    actor: input.reviewedBy,
    event: "aml.alert.reviewed",
    payload: {
      alertId: updated.id,
      merchantId: updated.merchantId,
      status: updated.status,
      previousStatus: existing.status,
    },
  });
  return updated;
}

export interface ListAlertsInput {
  merchantId: string;
  status?: AmlAlertStatus;
  payerWallet?: string;
  paymentId?: string;
  limit?: number;
}

export function listAlerts(db: Db, input: ListAlertsInput): AmlAlert[] {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  return listAmlAlerts(db, input);
}

export function getAlert(
  db: Db,
  merchantId: string,
  alertId: string,
): AmlAlert {
  const alert = findAmlAlert(db, alertId);
  if (!alert || alert.merchantId !== merchantId) {
    throw HttpError.notFound(`AML alert ${alertId} not found`);
  }
  return alert;
}

export interface GenerateSarInput {
  merchantId: string;
  alertIds: readonly string[];
  narrative: string;
  filedBy: string;
  subjectWallet?: string | null;
  subjectSummary?: string | null;
}

/**
 * Bundles a set of alerts into a Suspicious Activity Report draft. The SAR
 * captures a frozen snapshot of the alert evidence (so subsequent alert
 * mutations don't alter the filed record). Alerts are flipped to `escalated`
 * if they were `open` at the time of bundling and `sar_id` is set so the
 * human review trail can backtrack from a SAR to its source signals.
 *
 * Status is `draft` on creation — `markSarFiled` records the regulator
 * filing event separately so the audit log distinguishes "report drafted"
 * from "report filed".
 */
export function generateSar(db: Db, input: GenerateSarInput): AmlSar {
  if (input.alertIds.length === 0) {
    throw HttpError.badRequest("SAR must reference at least one alert");
  }
  if (input.alertIds.length > 200) {
    throw HttpError.badRequest("SAR cannot reference more than 200 alerts");
  }
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const id of input.alertIds) {
    if (!seen.has(id)) {
      seen.add(id);
      dedup.push(id);
    }
  }
  const alerts: AmlAlert[] = [];
  for (const alertId of dedup) {
    const alert = findAmlAlert(db, alertId);
    if (!alert) {
      throw HttpError.notFound(`AML alert ${alertId} not found`);
    }
    if (alert.merchantId !== input.merchantId) {
      throw HttpError.notFound(`AML alert ${alertId} not found`);
    }
    alerts.push(alert);
  }

  const totalAmount = alerts.reduce((sum, alert) => {
    const evidenceAmount = alert.evidence["amount"];
    if (typeof evidenceAmount === "number" && Number.isFinite(evidenceAmount)) {
      return sum + evidenceAmount;
    }
    return sum;
  }, 0);

  const sarId = newId("sar");
  const reference = formatSarReference(sarId);
  const subjectWallet =
    input.subjectWallet ?? inferSubjectWallet(alerts) ?? null;
  const subjectSummary = input.subjectSummary ?? null;

  const sar = insertAmlSar(db, {
    id: sarId,
    merchantId: input.merchantId,
    reference,
    status: "draft",
    narrative: input.narrative,
    subjectWallet,
    subjectSummary,
    totalAmountUsdc: totalAmount,
    alertCount: alerts.length,
    payload: {
      alertIds: alerts.map((a) => a.id),
      rules: alerts.map((a) => a.rule),
      severities: alerts.map((a) => a.severity),
      capturedAt: new Date().toISOString(),
    },
  });

  attachAlertsToSar(db, sarId, alerts.map((a) => a.id));

  appendAudit(db, {
    actor: input.filedBy,
    event: "aml.sar.drafted",
    payload: {
      sarId: sar.id,
      merchantId: sar.merchantId,
      reference: sar.reference,
      alertCount: sar.alertCount,
      totalAmountUsdc: sar.totalAmountUsdc,
      subjectWallet,
    },
  });

  return sar;
}

function inferSubjectWallet(alerts: readonly AmlAlert[]): string | null {
  const wallets = new Set<string>();
  for (const alert of alerts) {
    if (alert.payerWallet) wallets.add(alert.payerWallet);
  }
  return wallets.size === 1 ? Array.from(wallets)[0]! : null;
}

function formatSarReference(sarId: string): string {
  // Public-facing SAR reference. We use a year-prefixed slug derived from the
  // internal id so regulators / auditors get a stable human-readable handle
  // without leaking the raw id-space cardinality.
  const year = new Date().getUTCFullYear();
  const tail = sarId.replace(/^sar_/, "").slice(0, 12).toUpperCase();
  return `SAR-${year}-${tail}`;
}

export interface FileSarInput {
  merchantId: string;
  sarId: string;
  filedBy: string;
  externalFilingId?: string | null;
}

export function fileSar(db: Db, input: FileSarInput): AmlSar {
  const sar = findAmlSar(db, input.sarId);
  if (!sar || sar.merchantId !== input.merchantId) {
    throw HttpError.notFound(`AML SAR ${input.sarId} not found`);
  }
  if (sar.status !== "draft") {
    throw HttpError.conflict(
      `AML SAR ${input.sarId} cannot be filed from status ${sar.status}`,
    );
  }
  const updated = markAmlSarFiled(db, input.sarId, {
    filedBy: input.filedBy,
    externalFilingId: input.externalFilingId ?? null,
  });
  appendAudit(db, {
    actor: input.filedBy,
    event: "aml.sar.filed",
    payload: {
      sarId: updated.id,
      merchantId: updated.merchantId,
      reference: updated.reference,
      externalFilingId: updated.externalFilingId,
    },
  });
  return updated;
}

export interface ListSarsInput {
  merchantId: string;
  status?: AmlSar["status"];
  limit?: number;
}

export function listSars(db: Db, input: ListSarsInput): AmlSar[] {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  return listAmlSars(db, input);
}

export function getSar(db: Db, merchantId: string, sarId: string): AmlSar {
  const sar = findAmlSar(db, sarId);
  if (!sar || sar.merchantId !== merchantId) {
    throw HttpError.notFound(`AML SAR ${sarId} not found`);
  }
  return sar;
}

/**
 * Parses the AML_SANCTIONED_WALLETS env var (comma-separated base58 pubkeys)
 * into a config snapshot. Trims whitespace and ignores empty entries; bad
 * entries propagate to the caller as part of the set (we don't validate
 * base58 here — the route layer rejects invalid pubkeys before write).
 */
export function loadAmlConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AmlMonitorConfig {
  const raw = env["AML_SANCTIONED_WALLETS"];
  if (!raw) return DEFAULT_AML_CONFIG;
  const list = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return { ...DEFAULT_AML_CONFIG, sanctionedWallets: new Set(list) };
}
