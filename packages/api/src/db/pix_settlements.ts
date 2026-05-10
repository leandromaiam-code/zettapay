import type { Database as Db } from "better-sqlite3";
import type { PixKeyType, PixProvider } from "../pix/client.js";

export type PixSettlementStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface PixSettlementRow {
  id: string;
  merchant_id: string;
  payment_id: string | null;
  provider: PixProvider;
  amount_usdc: number;
  fee_usdc: number;
  net_usdc: number;
  fee_bps: number;
  pix_key: string;
  pix_key_type: PixKeyType;
  withdrawal_id: string | null;
  quoted_brl: number | null;
  status: PixSettlementStatus;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface PixSettlement {
  id: string;
  merchantId: string;
  paymentId: string | null;
  provider: PixProvider;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  pixKey: string;
  pixKeyType: PixKeyType;
  withdrawalId: string | null;
  quotedBrl: number | null;
  status: PixSettlementStatus;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface CreatePixSettlementInput {
  id: string;
  merchantId: string;
  paymentId: string | null;
  provider: PixProvider;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  feeBps: number;
  pixKey: string;
  pixKeyType: PixKeyType;
}

function toSettlement(row: PixSettlementRow): PixSettlement {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentId: row.payment_id,
    provider: row.provider,
    amountUsdc: row.amount_usdc,
    feeUsdc: row.fee_usdc,
    netUsdc: row.net_usdc,
    feeBps: row.fee_bps,
    pixKey: row.pix_key,
    pixKeyType: row.pix_key_type,
    withdrawalId: row.withdrawal_id,
    quotedBrl: row.quoted_brl,
    status: row.status,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function insertPixSettlement(
  db: Db,
  input: CreatePixSettlementInput,
): PixSettlement {
  db.prepare<
    [
      string,
      string,
      string | null,
      string,
      number,
      number,
      number,
      number,
      string,
      string,
    ]
  >(
    `INSERT INTO pix_settlements
       (id, merchant_id, payment_id, provider, amount_usdc, fee_usdc, net_usdc,
        fee_bps, pix_key, pix_key_type, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.id,
    input.merchantId,
    input.paymentId,
    input.provider,
    input.amountUsdc,
    input.feeUsdc,
    input.netUsdc,
    input.feeBps,
    input.pixKey,
    input.pixKeyType,
  );
  return getPixSettlement(db, input.id);
}

export function markPixSettlementProcessing(db: Db, id: string): void {
  db.prepare<[string]>(
    `UPDATE pix_settlements SET status = 'processing'
       WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

export function markPixSettlementCompleted(
  db: Db,
  id: string,
  withdrawalId: string,
  quotedBrl: number | null,
): void {
  db.prepare<[string, number | null, string]>(
    `UPDATE pix_settlements
       SET status = 'completed',
           withdrawal_id = ?,
           quoted_brl = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ?`,
  ).run(withdrawalId, quotedBrl, id);
}

export function markPixSettlementFailed(
  db: Db,
  id: string,
  errorMessage: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE pix_settlements
       SET status = 'failed',
           error_message = ?
       WHERE id = ?`,
  ).run(errorMessage, id);
}

export function getPixSettlement(db: Db, id: string): PixSettlement {
  const row = db
    .prepare<[string]>("SELECT * FROM pix_settlements WHERE id = ?")
    .get(id) as PixSettlementRow | undefined;
  if (!row) {
    throw new Error(`pix settlement ${id} not found`);
  }
  return toSettlement(row);
}

export function findPixSettlementByPayment(
  db: Db,
  paymentId: string,
): PixSettlement | null {
  const row = db
    .prepare<[string]>(
      "SELECT * FROM pix_settlements WHERE payment_id = ?",
    )
    .get(paymentId) as PixSettlementRow | undefined;
  return row ? toSettlement(row) : null;
}

export function listPixSettlementsByMerchant(
  db: Db,
  merchantId: string,
  limit = 50,
): PixSettlement[] {
  const rows = db
    .prepare<[string, number]>(
      `SELECT * FROM pix_settlements
         WHERE merchant_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(merchantId, limit) as PixSettlementRow[];
  return rows.map(toSettlement);
}
