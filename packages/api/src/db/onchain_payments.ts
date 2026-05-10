import type { Database as Db } from "better-sqlite3";

/**
 * Z9.5 — local mirror of on-chain `Payment` receipt PDAs.
 *
 * The chain remains the source of truth (Z9 immutability). This table exists
 * solely so merchant dashboards / SDK queries can answer "show me receipts
 * for binding X" in a single indexed read instead of a `getProgramAccounts`
 * call (~seconds, often rate-limited on public RPC).
 *
 * Rows are upserted by PDA — re-ingestion of the same on-chain event is a
 * no-op past the first insert. `tx_signature` carries a UNIQUE index so the
 * mirror also enforces the program's `(merchant_binding, payment_id)`
 * idempotency contract at the relational layer.
 *
 * Premise §13 pins SQLite for dev / Postgres for prod. The schema is
 * intentionally portable: TEXT for ids / signatures, INTEGER for slot, and
 * the u64 `amount` is stored as TEXT to avoid lossy conversions through the
 * SQLite REAL type (Postgres NUMERIC will accept the same string verbatim).
 */
export interface OnChainPaymentRow {
  pda: string;
  merchant_binding: string;
  payment_id_hex: string;
  amount: string;
  tx_signature: string;
  recorded_at: number;
  slot: number | null;
  ingested_at: string;
}

export interface OnChainPaymentRecord {
  pda: string;
  merchantBinding: string;
  paymentIdHex: string;
  amount: bigint;
  txSignature: string;
  recordedAt: number;
  slot: number | null;
  ingestedAt: string;
}

export interface UpsertOnChainPaymentInput {
  pda: string;
  merchantBinding: string;
  paymentIdHex: string;
  amount: bigint;
  txSignature: string;
  recordedAt: number;
  slot?: number | null;
}

export interface UpsertResult {
  /** True when the row did not exist and was inserted; false on subsequent
   *  upserts of the same PDA. Lets the indexer separate "new receipt" from
   *  "duplicate webhook fire" in audit logs without a second query. */
  inserted: boolean;
  record: OnChainPaymentRecord;
}

function toRecord(row: OnChainPaymentRow): OnChainPaymentRecord {
  return {
    pda: row.pda,
    merchantBinding: row.merchant_binding,
    paymentIdHex: row.payment_id_hex,
    amount: BigInt(row.amount),
    txSignature: row.tx_signature,
    recordedAt: row.recorded_at,
    slot: row.slot,
    ingestedAt: row.ingested_at,
  };
}

export function upsertOnChainPayment(
  db: Db,
  input: UpsertOnChainPaymentInput,
): UpsertResult {
  const existing = db
    .prepare<[string]>("SELECT * FROM onchain_payments WHERE pda = ?")
    .get(input.pda) as OnChainPaymentRow | undefined;

  if (!existing) {
    db.prepare<[string, string, string, string, string, number, number | null]>(
      `INSERT INTO onchain_payments
         (pda, merchant_binding, payment_id_hex, amount, tx_signature, recorded_at, slot)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.pda,
      input.merchantBinding,
      input.paymentIdHex,
      input.amount.toString(),
      input.txSignature,
      input.recordedAt,
      input.slot ?? null,
    );
    const inserted = db
      .prepare<[string]>("SELECT * FROM onchain_payments WHERE pda = ?")
      .get(input.pda) as OnChainPaymentRow;
    return { inserted: true, record: toRecord(inserted) };
  }

  // Re-ingest only the slot if the new event is from a later slot. Receipt
  // fields are immutable on-chain, so re-writing them would either be a no-op
  // or evidence of a corrupted feed — refuse to overwrite the latter.
  if (
    existing.merchant_binding !== input.merchantBinding ||
    existing.payment_id_hex !== input.paymentIdHex ||
    existing.amount !== input.amount.toString() ||
    existing.tx_signature !== input.txSignature ||
    existing.recorded_at !== input.recordedAt
  ) {
    throw new Error(
      `onchain_payments mirror divergence at pda=${input.pda} — refusing to overwrite a recorded receipt with conflicting fields`,
    );
  }

  if (input.slot !== undefined && input.slot !== null) {
    if (existing.slot === null || input.slot > existing.slot) {
      db.prepare<[number, string]>(
        "UPDATE onchain_payments SET slot = ? WHERE pda = ?",
      ).run(input.slot, input.pda);
      existing.slot = input.slot;
    }
  }
  return { inserted: false, record: toRecord(existing) };
}

export function findOnChainPaymentByPda(
  db: Db,
  pda: string,
): OnChainPaymentRecord | null {
  const row = db
    .prepare<[string]>("SELECT * FROM onchain_payments WHERE pda = ?")
    .get(pda) as OnChainPaymentRow | undefined;
  return row ? toRecord(row) : null;
}

export function findOnChainPaymentBySignature(
  db: Db,
  txSignature: string,
): OnChainPaymentRecord | null {
  const row = db
    .prepare<[string]>("SELECT * FROM onchain_payments WHERE tx_signature = ?")
    .get(txSignature) as OnChainPaymentRow | undefined;
  return row ? toRecord(row) : null;
}

export interface ListOnChainPaymentsOptions {
  merchantBinding?: string;
  limit?: number;
  cursor?: number;
}

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

export function listOnChainPayments(
  db: Db,
  options: ListOnChainPaymentsOptions = {},
): OnChainPaymentRecord[] {
  const limit = clampLimit(options.limit);
  if (options.merchantBinding) {
    if (options.cursor !== undefined) {
      const rows = db
        .prepare<[string, number, number]>(
          `SELECT * FROM onchain_payments
           WHERE merchant_binding = ? AND recorded_at < ?
           ORDER BY recorded_at DESC
           LIMIT ?`,
        )
        .all(options.merchantBinding, options.cursor, limit) as OnChainPaymentRow[];
      return rows.map(toRecord);
    }
    const rows = db
      .prepare<[string, number]>(
        `SELECT * FROM onchain_payments
         WHERE merchant_binding = ?
         ORDER BY recorded_at DESC
         LIMIT ?`,
      )
      .all(options.merchantBinding, limit) as OnChainPaymentRow[];
    return rows.map(toRecord);
  }
  if (options.cursor !== undefined) {
    const rows = db
      .prepare<[number, number]>(
        `SELECT * FROM onchain_payments
         WHERE recorded_at < ?
         ORDER BY recorded_at DESC
         LIMIT ?`,
      )
      .all(options.cursor, limit) as OnChainPaymentRow[];
    return rows.map(toRecord);
  }
  const rows = db
    .prepare<[number]>(
      `SELECT * FROM onchain_payments
       ORDER BY recorded_at DESC
       LIMIT ?`,
    )
    .all(limit) as OnChainPaymentRow[];
  return rows.map(toRecord);
}

export function countOnChainPayments(
  db: Db,
  options: { merchantBinding?: string } = {},
): number {
  if (options.merchantBinding) {
    const row = db
      .prepare<[string]>(
        "SELECT COUNT(*) AS n FROM onchain_payments WHERE merchant_binding = ?",
      )
      .get(options.merchantBinding) as { n: number };
    return row.n;
  }
  const row = db
    .prepare<[]>("SELECT COUNT(*) AS n FROM onchain_payments")
    .get() as { n: number };
  return row.n;
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_LIST_LIMIT;
  }
  return Math.min(Math.floor(raw), MAX_LIST_LIMIT);
}
