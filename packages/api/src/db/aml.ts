import type { Database as Db } from "better-sqlite3";

export type AmlAlertRule =
  | "structuring"
  | "high_amount"
  | "velocity_spike"
  | "round_amount_pattern"
  | "sanctioned_wallet"
  | "rapid_repeat_payer";

export type AmlAlertSeverity = "low" | "medium" | "high" | "critical";

export type AmlAlertStatus = "open" | "reviewed" | "dismissed" | "escalated";

export type AmlSarStatus = "draft" | "filed" | "closed";

export interface AmlAlertRow {
  id: string;
  merchant_id: string;
  payment_id: string | null;
  payer_wallet: string | null;
  rule: AmlAlertRule;
  severity: AmlAlertSeverity;
  status: AmlAlertStatus;
  score: number;
  summary: string;
  evidence_json: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  sar_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface AmlAlert {
  id: string;
  merchantId: string;
  paymentId: string | null;
  payerWallet: string | null;
  rule: AmlAlertRule;
  severity: AmlAlertSeverity;
  status: AmlAlertStatus;
  score: number;
  summary: string;
  evidence: Record<string, unknown>;
  reviewedBy: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  sarId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertAmlAlertInput {
  id: string;
  merchantId: string;
  paymentId: string | null;
  payerWallet: string | null;
  rule: AmlAlertRule;
  severity: AmlAlertSeverity;
  score: number;
  summary: string;
  evidence: Record<string, unknown>;
}

export interface AmlSarRow {
  id: string;
  merchant_id: string;
  reference: string;
  status: AmlSarStatus;
  narrative: string;
  subject_wallet: string | null;
  subject_summary: string | null;
  total_amount_usdc: number;
  alert_count: number;
  filed_at: string | null;
  filed_by: string | null;
  external_filing_id: string | null;
  payload_json: string;
  created_at: string;
  updated_at: string;
}

export interface AmlSar {
  id: string;
  merchantId: string;
  reference: string;
  status: AmlSarStatus;
  narrative: string;
  subjectWallet: string | null;
  subjectSummary: string | null;
  totalAmountUsdc: number;
  alertCount: number;
  filedAt: string | null;
  filedBy: string | null;
  externalFilingId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface InsertAmlSarInput {
  id: string;
  merchantId: string;
  reference: string;
  status: AmlSarStatus;
  narrative: string;
  subjectWallet: string | null;
  subjectSummary: string | null;
  totalAmountUsdc: number;
  alertCount: number;
  payload: Record<string, unknown>;
}

function toAlert(row: AmlAlertRow): AmlAlert {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentId: row.payment_id,
    payerWallet: row.payer_wallet,
    rule: row.rule,
    severity: row.severity,
    status: row.status,
    score: row.score,
    summary: row.summary,
    evidence: row.evidence_json
      ? (JSON.parse(row.evidence_json) as Record<string, unknown>)
      : {},
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    reviewNotes: row.review_notes,
    sarId: row.sar_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSar(row: AmlSarRow): AmlSar {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    reference: row.reference,
    status: row.status,
    narrative: row.narrative,
    subjectWallet: row.subject_wallet,
    subjectSummary: row.subject_summary,
    totalAmountUsdc: row.total_amount_usdc,
    alertCount: row.alert_count,
    filedAt: row.filed_at,
    filedBy: row.filed_by,
    externalFilingId: row.external_filing_id,
    payload: row.payload_json
      ? (JSON.parse(row.payload_json) as Record<string, unknown>)
      : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertAmlAlert(db: Db, input: InsertAmlAlertInput): AmlAlert {
  db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      AmlAlertRule,
      AmlAlertSeverity,
      number,
      string,
      string,
    ]
  >(
    `INSERT INTO aml_alerts
       (id, merchant_id, payment_id, payer_wallet, rule, severity, status, score, summary, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
  ).run(
    input.id,
    input.merchantId,
    input.paymentId,
    input.payerWallet,
    input.rule,
    input.severity,
    input.score,
    input.summary,
    JSON.stringify(input.evidence ?? {}),
  );
  return getAmlAlert(db, input.id);
}

export function getAmlAlert(db: Db, id: string): AmlAlert {
  const alert = findAmlAlert(db, id);
  if (!alert) {
    throw new Error(`aml alert ${id} not found`);
  }
  return alert;
}

export function findAmlAlert(db: Db, id: string): AmlAlert | null {
  const row = db
    .prepare<[string]>("SELECT * FROM aml_alerts WHERE id = ?")
    .get(id) as AmlAlertRow | undefined;
  return row ? toAlert(row) : null;
}

export interface ListAmlAlertsOptions {
  merchantId: string;
  status?: AmlAlertStatus;
  payerWallet?: string;
  paymentId?: string;
  limit?: number;
}

export function listAmlAlerts(
  db: Db,
  options: ListAmlAlertsOptions,
): AmlAlert[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const clauses: string[] = ["merchant_id = ?"];
  const params: Array<string | number> = [options.merchantId];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.payerWallet) {
    clauses.push("payer_wallet = ?");
    params.push(options.payerWallet);
  }
  if (options.paymentId) {
    clauses.push("payment_id = ?");
    params.push(options.paymentId);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM aml_alerts
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params) as AmlAlertRow[];
  return rows.map(toAlert);
}

export interface UpdateAmlAlertReviewInput {
  status: AmlAlertStatus;
  reviewedBy: string;
  notes: string | null;
}

export function updateAmlAlertReview(
  db: Db,
  id: string,
  input: UpdateAmlAlertReviewInput,
): AmlAlert {
  const result = db
    .prepare<[AmlAlertStatus, string, string | null, string]>(
      `UPDATE aml_alerts
       SET status = ?,
           reviewed_by = ?,
           reviewed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           review_notes = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
    )
    .run(input.status, input.reviewedBy, input.notes, id);
  if (result.changes === 0) {
    throw new Error(`aml alert ${id} not found`);
  }
  return getAmlAlert(db, id);
}

export function attachAlertsToSar(
  db: Db,
  sarId: string,
  alertIds: readonly string[],
): number {
  if (alertIds.length === 0) return 0;
  const placeholders = alertIds.map(() => "?").join(",");
  const result = db
    .prepare(
      `UPDATE aml_alerts
       SET sar_id = ?,
           status = CASE WHEN status = 'open' THEN 'escalated' ELSE status END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id IN (${placeholders})`,
    )
    .run(sarId, ...alertIds);
  return result.changes;
}

export function findRecentPayerAlerts(
  db: Db,
  merchantId: string,
  payerWallet: string,
  rule: AmlAlertRule,
  sinceIso: string,
): AmlAlert[] {
  const rows = db
    .prepare<[string, string, AmlAlertRule, string]>(
      `SELECT * FROM aml_alerts
       WHERE merchant_id = ? AND payer_wallet = ? AND rule = ? AND created_at >= ?
       ORDER BY created_at DESC`,
    )
    .all(merchantId, payerWallet, rule, sinceIso) as AmlAlertRow[];
  return rows.map(toAlert);
}

export function insertAmlSar(db: Db, input: InsertAmlSarInput): AmlSar {
  db.prepare<
    [
      string,
      string,
      string,
      AmlSarStatus,
      string,
      string | null,
      string | null,
      number,
      number,
      string,
    ]
  >(
    `INSERT INTO aml_sars
       (id, merchant_id, reference, status, narrative, subject_wallet, subject_summary,
        total_amount_usdc, alert_count, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.merchantId,
    input.reference,
    input.status,
    input.narrative,
    input.subjectWallet,
    input.subjectSummary,
    input.totalAmountUsdc,
    input.alertCount,
    JSON.stringify(input.payload ?? {}),
  );
  return getAmlSar(db, input.id);
}

export function getAmlSar(db: Db, id: string): AmlSar {
  const sar = findAmlSar(db, id);
  if (!sar) {
    throw new Error(`aml sar ${id} not found`);
  }
  return sar;
}

export function findAmlSar(db: Db, id: string): AmlSar | null {
  const row = db
    .prepare<[string]>("SELECT * FROM aml_sars WHERE id = ?")
    .get(id) as AmlSarRow | undefined;
  return row ? toSar(row) : null;
}

export interface ListAmlSarsOptions {
  merchantId: string;
  status?: AmlSarStatus;
  limit?: number;
}

export function listAmlSars(db: Db, options: ListAmlSarsOptions): AmlSar[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const clauses: string[] = ["merchant_id = ?"];
  const params: Array<string | number> = [options.merchantId];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM aml_sars
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(...params) as AmlSarRow[];
  return rows.map(toSar);
}

export interface MarkSarFiledInput {
  filedBy: string;
  externalFilingId: string | null;
}

export function markAmlSarFiled(
  db: Db,
  id: string,
  input: MarkSarFiledInput,
): AmlSar {
  const result = db
    .prepare<[string, string | null, string]>(
      `UPDATE aml_sars
       SET status = 'filed',
           filed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           filed_by = ?,
           external_filing_id = ?,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND status = 'draft'`,
    )
    .run(input.filedBy, input.externalFilingId, id);
  if (result.changes === 0) {
    throw new Error(`aml sar ${id} not found or not in draft status`);
  }
  return getAmlSar(db, id);
}
