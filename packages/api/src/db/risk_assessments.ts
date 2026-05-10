import type { Database as Db } from "better-sqlite3";

export type RiskDecision = "allow" | "review";
export type RiskReviewStatus = "pending" | "approved" | "rejected";

export interface RiskSignal {
  type: string;
  weight: number;
  detail?: string;
}

export interface RiskAssessmentRow {
  id: string;
  payment_id: string | null;
  merchant_id: string;
  payer_wallet: string;
  amount_usdc: number;
  score: number;
  threshold: number;
  signals_json: string;
  decision: RiskDecision;
  review_status: RiskReviewStatus | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_reason: string | null;
  created_at: string;
}

export interface RiskAssessment {
  id: string;
  paymentId: string | null;
  merchantId: string;
  payerWallet: string;
  amountUsdc: number;
  score: number;
  threshold: number;
  signals: RiskSignal[];
  decision: RiskDecision;
  reviewStatus: RiskReviewStatus | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewReason: string | null;
  createdAt: string;
}

export interface InsertRiskAssessmentInput {
  id: string;
  paymentId: string | null;
  merchantId: string;
  payerWallet: string;
  amountUsdc: number;
  score: number;
  threshold: number;
  signals: RiskSignal[];
  decision: RiskDecision;
  reviewStatus: RiskReviewStatus | null;
}

function toAssessment(row: RiskAssessmentRow): RiskAssessment {
  return {
    id: row.id,
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    payerWallet: row.payer_wallet,
    amountUsdc: row.amount_usdc,
    score: row.score,
    threshold: row.threshold,
    signals: JSON.parse(row.signals_json) as RiskSignal[],
    decision: row.decision,
    reviewStatus: row.review_status,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewReason: row.review_reason,
    createdAt: row.created_at,
  };
}

export function insertRiskAssessment(
  db: Db,
  input: InsertRiskAssessmentInput,
): RiskAssessment {
  db.prepare<
    [
      string,
      string | null,
      string,
      string,
      number,
      number,
      number,
      string,
      RiskDecision,
      RiskReviewStatus | null,
    ]
  >(
    `INSERT INTO risk_assessments (
       id, payment_id, merchant_id, payer_wallet, amount_usdc,
       score, threshold, signals_json, decision, review_status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.paymentId,
    input.merchantId,
    input.payerWallet,
    input.amountUsdc,
    input.score,
    input.threshold,
    JSON.stringify(input.signals),
    input.decision,
    input.reviewStatus,
  );
  return getRiskAssessment(db, input.id);
}

export function getRiskAssessment(db: Db, id: string): RiskAssessment {
  const row = db
    .prepare<[string]>("SELECT * FROM risk_assessments WHERE id = ?")
    .get(id) as RiskAssessmentRow | undefined;
  if (!row) {
    throw new Error(`risk_assessment ${id} not found`);
  }
  return toAssessment(row);
}

export function findRiskAssessment(
  db: Db,
  id: string,
): RiskAssessment | null {
  const row = db
    .prepare<[string]>("SELECT * FROM risk_assessments WHERE id = ?")
    .get(id) as RiskAssessmentRow | undefined;
  return row ? toAssessment(row) : null;
}

export interface ListReviewQueueOptions {
  merchantId: string;
  status?: RiskReviewStatus;
  limit?: number;
}

export function listReviewQueue(
  db: Db,
  options: ListReviewQueueOptions,
): RiskAssessment[] {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const status = options.status ?? "pending";
  const rows = db
    .prepare<[string, RiskReviewStatus, number]>(
      `SELECT * FROM risk_assessments
        WHERE merchant_id = ? AND review_status = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(options.merchantId, status, limit) as RiskAssessmentRow[];
  return rows.map(toAssessment);
}

export function updateReviewStatus(
  db: Db,
  id: string,
  input: {
    reviewStatus: RiskReviewStatus;
    reviewedBy: string;
    reviewReason: string | null;
  },
): RiskAssessment {
  const result = db
    .prepare<[RiskReviewStatus, string, string | null, string]>(
      `UPDATE risk_assessments
          SET review_status = ?,
              reviewed_by   = ?,
              review_reason = ?,
              reviewed_at   = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
    )
    .run(input.reviewStatus, input.reviewedBy, input.reviewReason, id);
  if (result.changes === 0) {
    throw new Error(`risk_assessment ${id} not found`);
  }
  return getRiskAssessment(db, id);
}
