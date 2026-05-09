import type { Database as Db } from "better-sqlite3";

export type PaymentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "refunded";

export interface PaymentRow {
  id: string;
  merchant_id: string;
  amount_usdc: number;
  payer_wallet: string;
  status: PaymentStatus;
  tx_signature: string | null;
  error_message: string | null;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Payment {
  id: string;
  merchantId: string;
  amountUsdc: number;
  payerWallet: string;
  status: PaymentStatus;
  txSignature: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface CreatePaymentInput {
  id: string;
  merchantId: string;
  amountUsdc: number;
  payerWallet: string;
  metadata: Record<string, unknown> | null;
}

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    amountUsdc: row.amount_usdc,
    payerWallet: row.payer_wallet,
    status: row.status,
    txSignature: row.tx_signature,
    errorMessage: row.error_message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function insertPayment(db: Db, input: CreatePaymentInput): Payment {
  const stmt = db.prepare<[string, string, number, string, string | null]>(
    `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, metadata_json)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  );
  stmt.run(
    input.id,
    input.merchantId,
    input.amountUsdc,
    input.payerWallet,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return getPayment(db, input.id);
}

export function markPaymentProcessing(db: Db, id: string): void {
  db.prepare<[string]>(
    `UPDATE payments SET status = 'processing' WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

export function markPaymentCompleted(
  db: Db,
  id: string,
  txSignature: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE payments
     SET status = 'completed',
         tx_signature = ?,
         completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(txSignature, id);
}

export function markPaymentFailed(
  db: Db,
  id: string,
  errorMessage: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE payments
     SET status = 'failed',
         error_message = ?
     WHERE id = ?`,
  ).run(errorMessage, id);
}

export function getPayment(db: Db, id: string): Payment {
  const row = db
    .prepare<[string]>("SELECT * FROM payments WHERE id = ?")
    .get(id) as PaymentRow | undefined;
  if (!row) {
    throw new Error(`payment ${id} not found`);
  }
  return toPayment(row);
}

export function findPaymentBySignature(
  db: Db,
  txSignature: string,
): Payment | null {
  const row = db
    .prepare<[string]>("SELECT * FROM payments WHERE tx_signature = ?")
    .get(txSignature) as PaymentRow | undefined;
  return row ? toPayment(row) : null;
}
