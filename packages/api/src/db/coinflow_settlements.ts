import type { Database as Db } from "better-sqlite3";

export type SettlementStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface SettlementRow {
  id: string;
  merchant_id: string;
  payment_id: string | null;
  amount_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  fee_bps: number;
  bank_account_id: string;
  withdrawal_id: string | null;
  status: SettlementStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Settlement {
  id: string;
  merchantId: string;
  paymentId: string | null;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  bankAccountId: string;
  withdrawalId: string | null;
  status: SettlementStatus;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateSettlementInput {
  id: string;
  merchantId: string;
  paymentId: string | null;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  bankAccountId: string;
}

function toSettlement(row: SettlementRow): Settlement {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentId: row.payment_id,
    amountUsdc: row.amount_usdc,
    feeUsdc: row.fee_usdc,
    netUsdc: row.net_usdc,
    feeBps: row.fee_bps,
    bankAccountId: row.bank_account_id,
    withdrawalId: row.withdrawal_id,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function insertSettlement(
  db: Db,
  input: CreateSettlementInput,
): Settlement {
  db.prepare<
    [string, string, string | null, number, number, number, number, string]
  >(
    `INSERT INTO coinflow_settlements
       (id, merchant_id, payment_id, amount_usdc, fee_usdc, net_usdc, fee_bps, bank_account_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.id,
    input.merchantId,
    input.paymentId,
    input.amountUsdc,
    input.feeUsdc,
    input.netUsdc,
    input.feeBps,
    input.bankAccountId,
  );
  return getSettlement(db, input.id);
}

export function markSettlementProcessing(db: Db, id: string): void {
  db.prepare<[string]>(
    `UPDATE coinflow_settlements SET status = 'processing'
       WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

export function markSettlementCompleted(
  db: Db,
  id: string,
  withdrawalId: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE coinflow_settlements
       SET status = 'completed',
           withdrawal_id = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(withdrawalId, id);
}

export function markSettlementFailed(
  db: Db,
  id: string,
  errorMessage: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE coinflow_settlements
       SET status = 'failed',
           error_message = ?
       WHERE id = ?`,
  ).run(errorMessage, id);
}

export function getSettlement(db: Db, id: string): Settlement {
  const row = db
    .prepare<[string]>("SELECT * FROM coinflow_settlements WHERE id = ?")
    .get(id) as SettlementRow | undefined;
  if (!row) {
    throw new Error(`settlement ${id} not found`);
  }
  return toSettlement(row);
}

export function findSettlementByPayment(
  db: Db,
  paymentId: string,
): Settlement | null {
  const row = db
    .prepare<[string]>(
      "SELECT * FROM coinflow_settlements WHERE payment_id = ?",
    )
    .get(paymentId) as SettlementRow | undefined;
  return row ? toSettlement(row) : null;
}

export function listSettlementsByMerchant(
  db: Db,
  merchantId: string,
  limit = 50,
): Settlement[] {
  const rows = db
    .prepare<[string, number]>(
      `SELECT * FROM coinflow_settlements
         WHERE merchant_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(merchantId, limit) as SettlementRow[];
  return rows.map(toSettlement);
}
