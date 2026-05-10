import type { Database as Db } from "better-sqlite3";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";

export type RefundStatus = "pending" | "processing" | "completed" | "failed";

export interface RefundRow {
  id: string;
  payment_id: string;
  merchant_id: string;
  amount_usdc: number;
  currency: string;
  reason: string;
  status: RefundStatus;
  tx_signature: string | null;
  error_message: string | null;
  signed_by: string;
  signed_at: string;
  signature: string;
  created_at: string;
  completed_at: string | null;
}

export interface Refund {
  id: string;
  paymentId: string;
  merchantId: string;
  amountUsdc: number;
  currency: Currency;
  reason: string;
  status: RefundStatus;
  txSignature: string | null;
  errorMessage: string | null;
  signedBy: string;
  signedAt: string;
  signature: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateRefundInput {
  id: string;
  paymentId: string;
  merchantId: string;
  amountUsdc: number;
  currency: Currency;
  reason: string;
  signedBy: string;
  signedAt: string;
  signature: string;
}

function toRefund(row: RefundRow): Refund {
  return {
    id: row.id,
    paymentId: row.payment_id,
    merchantId: row.merchant_id,
    amountUsdc: row.amount_usdc,
    currency: ((row.currency ?? DEFAULT_CURRENCY) as Currency),
    reason: row.reason,
    status: row.status,
    txSignature: row.tx_signature,
    errorMessage: row.error_message,
    signedBy: row.signed_by,
    signedAt: row.signed_at,
    signature: row.signature,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function insertRefund(db: Db, input: CreateRefundInput): Refund {
  db.prepare<
    [string, string, string, number, string, string, string, string, string]
  >(
    `INSERT INTO refunds (id, payment_id, merchant_id, amount_usdc, currency, reason,
                          status, signed_by, signed_at, signature)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(
    input.id,
    input.paymentId,
    input.merchantId,
    input.amountUsdc,
    input.currency,
    input.reason,
    input.signedBy,
    input.signedAt,
    input.signature,
  );
  return getRefund(db, input.id);
}

export function getRefund(db: Db, id: string): Refund {
  const row = db
    .prepare<[string]>("SELECT * FROM refunds WHERE id = ?")
    .get(id) as RefundRow | undefined;
  if (!row) throw new Error(`refund ${id} not found`);
  return toRefund(row);
}

export function findRefundByPaymentId(
  db: Db,
  paymentId: string,
): Refund | null {
  const row = db
    .prepare<[string]>("SELECT * FROM refunds WHERE payment_id = ?")
    .get(paymentId) as RefundRow | undefined;
  return row ? toRefund(row) : null;
}

export function markRefundProcessing(db: Db, id: string): void {
  db.prepare<[string]>(
    `UPDATE refunds SET status = 'processing' WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

export function markRefundCompleted(
  db: Db,
  id: string,
  txSignature: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE refunds
     SET status = 'completed',
         tx_signature = ?,
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(txSignature, id);
}

export function markRefundFailed(
  db: Db,
  id: string,
  errorMessage: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE refunds
     SET status = 'failed',
         error_message = ?
     WHERE id = ?`,
  ).run(errorMessage, id);
}
