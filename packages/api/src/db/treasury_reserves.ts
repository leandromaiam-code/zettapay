import type { Database as Db } from "better-sqlite3";

export type TreasuryEntryKind = "credit" | "debit";

export type TreasuryEntryReason =
  | "tpv_contribution"
  | "manual_top_up"
  | "incident_refund"
  | "operational_drawdown"
  | "rebalance";

export interface TreasuryReserveEntryRow {
  id: string;
  kind: TreasuryEntryKind;
  amount_usdc: number;
  reason: TreasuryEntryReason;
  payment_id: string | null;
  merchant_id: string | null;
  external_ref: string | null;
  memo: string | null;
  actor: string;
  created_at: string;
}

export interface TreasuryReserveEntry {
  id: string;
  kind: TreasuryEntryKind;
  amountUsdc: number;
  reason: TreasuryEntryReason;
  paymentId: string | null;
  merchantId: string | null;
  externalRef: string | null;
  memo: string | null;
  actor: string;
  createdAt: string;
}

export interface InsertTreasuryEntryInput {
  id: string;
  kind: TreasuryEntryKind;
  amountUsdc: number;
  reason: TreasuryEntryReason;
  paymentId?: string | null;
  merchantId?: string | null;
  externalRef?: string | null;
  memo?: string | null;
  actor: string;
}

function toEntry(row: TreasuryReserveEntryRow): TreasuryReserveEntry {
  return {
    id: row.id,
    kind: row.kind,
    amountUsdc: row.amount_usdc,
    reason: row.reason,
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    externalRef: row.external_ref,
    memo: row.memo,
    actor: row.actor,
    createdAt: row.created_at,
  };
}

export function insertTreasuryEntry(
  db: Db,
  input: InsertTreasuryEntryInput,
): TreasuryReserveEntry {
  db.prepare<
    [
      string,
      TreasuryEntryKind,
      number,
      TreasuryEntryReason,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ]
  >(
    `INSERT INTO treasury_reserve_entries
       (id, kind, amount_usdc, reason, payment_id, merchant_id, external_ref, memo, actor)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.amountUsdc,
    input.reason,
    input.paymentId ?? null,
    input.merchantId ?? null,
    input.externalRef ?? null,
    input.memo ?? null,
    input.actor,
  );
  return getTreasuryEntry(db, input.id);
}

export function getTreasuryEntry(
  db: Db,
  id: string,
): TreasuryReserveEntry {
  const row = db
    .prepare<[string]>("SELECT * FROM treasury_reserve_entries WHERE id = ?")
    .get(id) as TreasuryReserveEntryRow | undefined;
  if (!row) {
    throw new Error(`treasury reserve entry ${id} not found`);
  }
  return toEntry(row);
}

export interface TreasuryReserveTotals {
  creditUsdc: number;
  debitUsdc: number;
  balanceUsdc: number;
  entryCount: number;
}

export function getTreasuryTotals(db: Db): TreasuryReserveTotals {
  const row = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN kind = 'credit' THEN amount_usdc ELSE 0 END), 0) AS credit_total,
         COALESCE(SUM(CASE WHEN kind = 'debit'  THEN amount_usdc ELSE 0 END), 0) AS debit_total,
         COUNT(*) AS entry_count
       FROM treasury_reserve_entries`,
    )
    .get() as
    | { credit_total: number; debit_total: number; entry_count: number }
    | undefined;
  const credit = row?.credit_total ?? 0;
  const debit = row?.debit_total ?? 0;
  const count = row?.entry_count ?? 0;
  return {
    creditUsdc: credit,
    debitUsdc: debit,
    balanceUsdc: credit - debit,
    entryCount: count,
  };
}

export interface CompletedTpvSummary {
  totalUsdc: number;
  paymentCount: number;
}

export function getCompletedTpv(db: Db): CompletedTpvSummary {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total, COUNT(*) AS n
       FROM payments
       WHERE status = 'completed'`,
    )
    .get() as { total: number; n: number } | undefined;
  return {
    totalUsdc: row?.total ?? 0,
    paymentCount: row?.n ?? 0,
  };
}

export interface ListTreasuryOptions {
  kind?: TreasuryEntryKind;
  reason?: TreasuryEntryReason;
  limit?: number;
}

export function listTreasuryEntries(
  db: Db,
  options: ListTreasuryOptions = {},
): TreasuryReserveEntry[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.kind) {
    clauses.push("kind = ?");
    params.push(options.kind);
  }
  if (options.reason) {
    clauses.push("reason = ?");
    params.push(options.reason);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM treasury_reserve_entries ${where}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(...params) as TreasuryReserveEntryRow[];
  return rows.map(toEntry);
}

export function findTpvContributionByPayment(
  db: Db,
  paymentId: string,
): TreasuryReserveEntry | null {
  const row = db
    .prepare<[string]>(
      `SELECT * FROM treasury_reserve_entries
       WHERE payment_id = ? AND reason = 'tpv_contribution'
       LIMIT 1`,
    )
    .get(paymentId) as TreasuryReserveEntryRow | undefined;
  return row ? toEntry(row) : null;
}
