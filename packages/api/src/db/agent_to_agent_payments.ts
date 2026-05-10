import type { Database as Db } from "better-sqlite3";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";

export type AgentToAgentPaymentStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed";

export interface AgentToAgentPaymentRow {
  id: string;
  payer_agent_identity_id: string;
  payee_agent_identity_id: string;
  payer_wallet: string;
  payee_wallet: string;
  amount_usdc: number;
  currency: string | null;
  task_ref: string | null;
  status: AgentToAgentPaymentStatus;
  tx_signature: string | null;
  error_message: string | null;
  metadata_json: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface AgentToAgentPayment {
  id: string;
  payerAgentIdentityId: string;
  payeeAgentIdentityId: string;
  payerWallet: string;
  payeeWallet: string;
  amountUsdc: number;
  currency: Currency;
  taskRef: string | null;
  status: AgentToAgentPaymentStatus;
  txSignature: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
}

export interface CreateAgentToAgentPaymentInput {
  id: string;
  payerAgentIdentityId: string;
  payeeAgentIdentityId: string;
  payerWallet: string;
  payeeWallet: string;
  amountUsdc: number;
  currency?: Currency;
  taskRef?: string | null;
  metadata?: Record<string, unknown> | null;
}

function toAgentToAgentPayment(
  row: AgentToAgentPaymentRow,
): AgentToAgentPayment {
  return {
    id: row.id,
    payerAgentIdentityId: row.payer_agent_identity_id,
    payeeAgentIdentityId: row.payee_agent_identity_id,
    payerWallet: row.payer_wallet,
    payeeWallet: row.payee_wallet,
    amountUsdc: row.amount_usdc,
    currency: ((row.currency ?? DEFAULT_CURRENCY) as Currency),
    taskRef: row.task_ref,
    status: row.status,
    txSignature: row.tx_signature,
    errorMessage: row.error_message,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export function insertAgentToAgentPayment(
  db: Db,
  input: CreateAgentToAgentPaymentInput,
): AgentToAgentPayment {
  db.prepare<
    [
      string,
      string,
      string,
      string,
      string,
      number,
      string,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO agent_to_agent_payments (
       id,
       payer_agent_identity_id,
       payee_agent_identity_id,
       payer_wallet,
       payee_wallet,
       amount_usdc,
       currency,
       task_ref,
       metadata_json,
       status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
  ).run(
    input.id,
    input.payerAgentIdentityId,
    input.payeeAgentIdentityId,
    input.payerWallet,
    input.payeeWallet,
    input.amountUsdc,
    input.currency ?? DEFAULT_CURRENCY,
    input.taskRef ?? null,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return getAgentToAgentPayment(db, input.id);
}

export function markAgentToAgentPaymentProcessing(db: Db, id: string): void {
  db.prepare<[string]>(
    `UPDATE agent_to_agent_payments
       SET status = 'processing'
     WHERE id = ? AND status = 'pending'`,
  ).run(id);
}

export function markAgentToAgentPaymentCompleted(
  db: Db,
  id: string,
  txSignature: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE agent_to_agent_payments
       SET status = 'completed',
           tx_signature = ?,
           completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(txSignature, id);
}

export function markAgentToAgentPaymentFailed(
  db: Db,
  id: string,
  errorMessage: string,
): void {
  db.prepare<[string, string]>(
    `UPDATE agent_to_agent_payments
       SET status = 'failed',
           error_message = ?
     WHERE id = ?`,
  ).run(errorMessage, id);
}

export function getAgentToAgentPayment(
  db: Db,
  id: string,
): AgentToAgentPayment {
  const row = db
    .prepare<[string]>("SELECT * FROM agent_to_agent_payments WHERE id = ?")
    .get(id) as AgentToAgentPaymentRow | undefined;
  if (!row) throw new Error(`agent_to_agent_payments ${id} not found`);
  return toAgentToAgentPayment(row);
}

export function findAgentToAgentPayment(
  db: Db,
  id: string,
): AgentToAgentPayment | null {
  const row = db
    .prepare<[string]>("SELECT * FROM agent_to_agent_payments WHERE id = ?")
    .get(id) as AgentToAgentPaymentRow | undefined;
  return row ? toAgentToAgentPayment(row) : null;
}

export interface ListAgentToAgentPaymentsInput {
  agentIdentityId: string;
  /** "payer", "payee", or "any" — defaults to "any". */
  role?: "payer" | "payee" | "any";
  limit?: number;
}

export function listAgentToAgentPayments(
  db: Db,
  input: ListAgentToAgentPaymentsInput,
): AgentToAgentPayment[] {
  const role = input.role ?? "any";
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  let where: string;
  let params: string[];
  if (role === "payer") {
    where = "payer_agent_identity_id = ?";
    params = [input.agentIdentityId];
  } else if (role === "payee") {
    where = "payee_agent_identity_id = ?";
    params = [input.agentIdentityId];
  } else {
    where = "payer_agent_identity_id = ? OR payee_agent_identity_id = ?";
    params = [input.agentIdentityId, input.agentIdentityId];
  }
  const rows = db
    .prepare(
      `SELECT * FROM agent_to_agent_payments
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit}`,
    )
    .all(...params) as AgentToAgentPaymentRow[];
  return rows.map(toAgentToAgentPayment);
}

export function sumAgentToAgentSpendSince(
  db: Db,
  payerAgentIdentityId: string,
  sinceIso: string,
): number {
  const row = db
    .prepare<[string, string]>(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total
         FROM agent_to_agent_payments
        WHERE payer_agent_identity_id = ?
          AND created_at >= ?
          AND status != 'failed'`,
    )
    .get(payerAgentIdentityId, sinceIso) as { total: number } | undefined;
  return row?.total ?? 0;
}
