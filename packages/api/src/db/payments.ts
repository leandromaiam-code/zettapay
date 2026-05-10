import type { Database as Db } from "better-sqlite3";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";

export type PaymentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "refunded";

/** Chain a payment was settled on. `solana` is the historical default. */
export type PaymentChain = "solana" | "base" | "base-sepolia" | "polygon" | "polygon-amoy";

export interface PaymentRow {
  id: string;
  merchant_id: string;
  amount_usdc: number;
  payer_wallet: string;
  status: PaymentStatus;
  tx_signature: string | null;
  error_message: string | null;
  metadata_json: string | null;
  currency: string | null;
  agent_identity_id: string | null;
  chain: string | null;
  payer_ip: string | null;
  payer_country: string | null;
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
  currency: Currency;
  agentIdentityId: string | null;
  chain: PaymentChain;
  createdAt: string;
  completedAt: string | null;
}

export interface CreatePaymentInput {
  id: string;
  merchantId: string;
  amountUsdc: number;
  payerWallet: string;
  metadata: Record<string, unknown> | null;
  currency?: Currency;
  agentIdentityId?: string | null;
  chain?: PaymentChain;
  payerIp?: string | null;
  payerCountry?: string | null;
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
    currency: ((row.currency ?? DEFAULT_CURRENCY) as Currency),
    agentIdentityId: row.agent_identity_id,
    chain: ((row.chain ?? "solana") as PaymentChain),
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export interface PayerHistoryRow {
  amountUsdc: number;
  country: string | null;
  createdAt: string;
}

/** Returns recent non-failed payments for a (merchant, payer_wallet) pair,
 * newest first. Used by the Z13.3 anomaly detector to compute z-score baselines
 * and historical country/time-of-day distributions. Failed rows are excluded
 * so a thrash of failed attempts can't poison the baseline. */
export function listPayerPaymentHistory(
  db: Db,
  merchantId: string,
  payerWallet: string,
  sinceIso: string,
  limit: number,
): PayerHistoryRow[] {
  const safeLimit = Math.max(1, Math.min(limit, 1000));
  const rows = db
    .prepare<[string, string, string, number]>(
      `SELECT amount_usdc, payer_country, created_at FROM payments
       WHERE merchant_id = ? AND payer_wallet = ? AND created_at >= ?
         AND status != 'failed'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(merchantId, payerWallet, sinceIso, safeLimit) as Array<{
      amount_usdc: number;
      payer_country: string | null;
      created_at: string;
    }>;
  return rows.map((r) => ({
    amountUsdc: r.amount_usdc,
    country: r.payer_country,
    createdAt: r.created_at,
  }));
}

export function insertPayment(db: Db, input: CreatePaymentInput): Payment {
  const stmt = db.prepare<
    [
      string,
      string,
      number,
      string,
      string | null,
      string,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, metadata_json, currency, agent_identity_id)
    [string, string, number, string, string | null, string, string]
  >(
    `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, metadata_json, currency, chain)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
    `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, metadata_json, currency, agent_identity_id, payer_ip, payer_country)
     VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    input.id,
    input.merchantId,
    input.amountUsdc,
    input.payerWallet,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.currency ?? DEFAULT_CURRENCY,
    input.agentIdentityId ?? null,
    input.chain ?? "solana",
    input.payerIp ?? null,
    input.payerCountry ?? null,
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

/**
 * Z13.5: flip a `completed` payment to `refunded`. Uses the existing
 * `completed` predicate so a payment in any other state cannot be marked
 * refunded out-of-band — the refund service treats the 0-row update as a
 * caller-side state error.
 */
export function markPaymentRefunded(db: Db, id: string): number {
  const result = db
    .prepare<[string]>(
      `UPDATE payments SET status = 'refunded' WHERE id = ? AND status = 'completed'`,
    )
    .run(id);
  return result.changes;
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

export function findPaymentById(db: Db, id: string): Payment | null {
  const row = db
    .prepare<[string]>("SELECT * FROM payments WHERE id = ?")
    .get(id) as PaymentRow | undefined;
  return row ? toPayment(row) : null;
}

// Velocity windows count any payment row whose status is not `failed` —
// pending/processing/completed all consume budget. Failed transfers must NOT
// shield an attacker from rate caps (they'd retry until success otherwise),
// but a refused row with `status='failed'` is a known-bad and shouldn't be
// charged against legitimate future spend.
const VELOCITY_STATUS_FILTER = "status != 'failed'";

export function countPaymentsByPayerSince(
  db: Db,
  merchantId: string,
  payerWallet: string,
  sinceIso: string,
): number {
  const row = db
    .prepare<[string, string, string]>(
      `SELECT COUNT(*) AS n FROM payments
       WHERE merchant_id = ? AND payer_wallet = ? AND created_at >= ?
         AND ${VELOCITY_STATUS_FILTER}`,
    )
    .get(merchantId, payerWallet, sinceIso) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function sumPaymentAmountByMerchantSince(
  db: Db,
  merchantId: string,
  sinceIso: string,
): number {
  const row = db
    .prepare<[string, string]>(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM payments
       WHERE merchant_id = ? AND created_at >= ?
         AND ${VELOCITY_STATUS_FILTER}`,
    )
    .get(merchantId, sinceIso) as { total: number } | undefined;
  return row?.total ?? 0;
}

export function sumPaymentAmountByAgentSince(
  db: Db,
  merchantId: string,
  agentIdentityId: string,
  sinceIso: string,
): number {
  const row = db
    .prepare<[string, string, string]>(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total FROM payments
       WHERE merchant_id = ? AND agent_identity_id = ? AND created_at >= ?
         AND ${VELOCITY_STATUS_FILTER}`,
    )
    .get(merchantId, agentIdentityId, sinceIso) as { total: number } | undefined;
  return row?.total ?? 0;
}
