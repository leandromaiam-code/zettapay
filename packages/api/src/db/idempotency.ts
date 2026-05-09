import type { Database as Db } from "better-sqlite3";

export interface IdempotencyRow {
  scope: string;
  key: string;
  request_hash: string;
  response_status: number;
  response_body: string;
  created_at: string;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
  createdAt: string;
}

export interface InsertIdempotencyInput {
  scope: string;
  key: string;
  requestHash: string;
  responseStatus: number;
  responseBody: string;
}

function toRecord(row: IdempotencyRow): IdempotencyRecord {
  return {
    scope: row.scope,
    key: row.key,
    requestHash: row.request_hash,
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
  };
}

export function findIdempotencyRecord(
  db: Db,
  scope: string,
  key: string,
): IdempotencyRecord | null {
  const row = db
    .prepare<[string, string]>(
      "SELECT scope, key, request_hash, response_status, response_body, created_at FROM idempotency_keys WHERE scope = ? AND key = ?",
    )
    .get(scope, key) as IdempotencyRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * Inserts a cached response for a given (scope, key). Returns false when a
 * concurrent request already populated the row (UNIQUE constraint races) — the
 * caller should treat that as a benign duplicate, not a failure.
 */
export function insertIdempotencyRecord(
  db: Db,
  input: InsertIdempotencyInput,
): boolean {
  try {
    db.prepare<[string, string, string, number, string]>(
      `INSERT INTO idempotency_keys (scope, key, request_hash, response_status, response_body)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      input.scope,
      input.key,
      input.requestHash,
      input.responseStatus,
      input.responseBody,
    );
    return true;
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return false;
    }
    throw err;
  }
}
