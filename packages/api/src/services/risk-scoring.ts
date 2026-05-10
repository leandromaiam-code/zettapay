import type { Database as Db } from "better-sqlite3";
import { appendAudit } from "../db/audit_journal.js";
import type { Merchant } from "../db/merchants.js";
import {
  countPaymentsByPayerSince,
  sumPaymentAmountByMerchantSince,
} from "../db/payments.js";
import {
  insertRiskAssessment,
  type RiskAssessment,
  type RiskSignal,
} from "../db/risk_assessments.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * 60_000;
const LOOKBACK_DAYS_MS = 30 * 24 * 60 * 60_000;

const SCORE_MIN = 0;
const SCORE_MAX = 100;

export interface RiskScoringInput {
  merchant: Merchant;
  payerWallet: string;
  amount: number;
  metadata: Record<string, unknown> | null;
  agentIdentityId?: string | null;
  /** Optional clock override for deterministic tests. */
  now?: Date;
}

export interface RiskScoringResult {
  score: number;
  threshold: number;
  signals: RiskSignal[];
  decision: "allow" | "review";
}

export interface EnforceRiskGateInput extends RiskScoringInput {
  /** When the caller pre-allocates a paymentId (e.g. for tracing) it is
   * stored on the assessment. Currently null because risk runs BEFORE the
   * payment row is created — kept for forward-compat with deferred-write
   * flows (Z11+ multi-currency review queues that may pre-insert). */
  paymentId?: string | null;
}

export interface EnforceRiskGateResult {
  assessment: RiskAssessment;
}

/**
 * Z13.4 fraud-score heuristic. Pure function — given a merchant + payment
 * attempt, returns a score in [0, 100] and the signals that contributed to
 * it. Higher = riskier. Designed to be replayable: every signal has a
 * stable `type` string and an integer weight so a future ML model can be
 * trained against the persisted `signals_json`.
 *
 * Signal weights are deliberately crude (no calibration data yet); the
 * default threshold of 70 is the gate that decides allow vs. review.
 */
export function computeRiskScore(
  db: Db,
  input: RiskScoringInput,
): RiskScoringResult {
  const { merchant, payerWallet, amount, metadata } = input;
  const now = input.now ?? new Date();
  const signals: RiskSignal[] = [];

  // Signal 1: high absolute amount. The thresholds match common fraud
  // industry "round-number" buckets. A single-cap miss adds nothing —
  // weights stack, so a $6k payment trips all three tiers.
  if (amount >= 5000) {
    signals.push({ type: "amount_very_high", weight: 30, detail: `${amount}` });
  } else if (amount >= 1000) {
    signals.push({ type: "amount_high", weight: 15, detail: `${amount}` });
  } else if (amount >= 500) {
    signals.push({ type: "amount_elevated", weight: 5, detail: `${amount}` });
  }

  // Signal 2: payer is new to this merchant. Counted over a 30d window so
  // returning customers don't spike on every new month. We exclude failed
  // attempts (same filter velocity uses) so a brute-forcer can't whitewash
  // themselves by intentionally failing payments.
  const lookbackIso = new Date(now.getTime() - LOOKBACK_DAYS_MS).toISOString();
  const priorCount = countPaymentsByPayerSince(
    db,
    merchant.id,
    payerWallet,
    lookbackIso,
  );
  if (priorCount === 0) {
    signals.push({ type: "new_payer", weight: 20, detail: "no prior 30d activity" });
  } else if (priorCount <= 2) {
    signals.push({ type: "low_history_payer", weight: 10, detail: `${priorCount} prior` });
  }

  // Signal 3: velocity pressure — payer is approaching the per-minute cap.
  // We weight at 5 per recent attempt so a payer 4-of-5 in window scores +20.
  const minuteIso = new Date(now.getTime() - ONE_MINUTE_MS).toISOString();
  const recentCount = countPaymentsByPayerSince(
    db,
    merchant.id,
    payerWallet,
    minuteIso,
  );
  if (recentCount > 0) {
    const weight = Math.min(20, recentCount * 5);
    signals.push({
      type: "velocity_pressure",
      weight,
      detail: `${recentCount} in last 60s`,
    });
  }

  // Signal 4: merchant-wide hour-spend pressure. If the merchant is close to
  // its hourly cap, treat new attempts as riskier (likely card-tester loop
  // late in window).
  if (merchant.velocity.maxAmountPerHour > 0) {
    const hourIso = new Date(now.getTime() - ONE_HOUR_MS).toISOString();
    const hourSpend = sumPaymentAmountByMerchantSince(db, merchant.id, hourIso);
    const ratio = (hourSpend + amount) / merchant.velocity.maxAmountPerHour;
    if (ratio >= 0.8) {
      signals.push({
        type: "hour_spend_pressure",
        weight: 15,
        detail: `${ratio.toFixed(2)} of cap`,
      });
    } else if (ratio >= 0.6) {
      signals.push({
        type: "hour_spend_warming",
        weight: 5,
        detail: `${ratio.toFixed(2)} of cap`,
      });
    }
  }

  // Signal 5: no order context. A real merchant integration always sends
  // some metadata (invoice id, cart id, sku). Total absence is correlated
  // with scripted/test traffic.
  if (!metadata || Object.keys(metadata).length === 0) {
    signals.push({ type: "no_metadata", weight: 5 });
  }

  const rawScore = signals.reduce((acc, sig) => acc + sig.weight, 0);
  const score = Math.max(SCORE_MIN, Math.min(SCORE_MAX, rawScore));
  const threshold = merchant.fraudReviewThreshold;
  const decision: "allow" | "review" = score > threshold ? "review" : "allow";

  return { score, threshold, signals, decision };
}

/**
 * Persists the assessment, audits the decision, and throws 403
 * `forbidden` with `scope: "fraud:review_queued"` when the score breaches
 * the merchant's threshold. Runs AFTER velocity/blacklist so a sanctioned
 * or rate-limited attempt never even reaches the model.
 *
 * Returns the persisted assessment on `allow` so the caller can correlate
 * the eventual payment row with the assessment id (Z21 audit trail).
 */
export function enforceRiskGate(
  db: Db,
  input: EnforceRiskGateInput,
): EnforceRiskGateResult {
  const result = computeRiskScore(db, input);
  const assessmentId = newId("risk");
  const assessment = insertRiskAssessment(db, {
    id: assessmentId,
    paymentId: input.paymentId ?? null,
    merchantId: input.merchant.id,
    payerWallet: input.payerWallet,
    amountUsdc: input.amount,
    score: result.score,
    threshold: result.threshold,
    signals: result.signals,
    decision: result.decision,
    reviewStatus: result.decision === "review" ? "pending" : null,
  });

  if (result.decision === "review") {
    appendAudit(db, {
      actor: `payer:${input.payerWallet}`,
      event: "payment.blocked.fraud_review",
      entityType: "merchant",
      entityId: input.merchant.id,
      reason: `risk score ${result.score} exceeded threshold ${result.threshold}`,
      payload: {
        scope: "fraud:review_queued",
        riskAssessmentId: assessmentId,
        score: result.score,
        threshold: result.threshold,
        signals: result.signals,
        amount: input.amount,
      },
    });
    throw HttpError.forbidden(
      `Payment queued for manual fraud review (score ${result.score} > ${result.threshold})`,
      {
        scope: "fraud:review_queued",
        riskAssessmentId: assessmentId,
        score: result.score,
        threshold: result.threshold,
      },
    );
  }

  return { assessment };
}
