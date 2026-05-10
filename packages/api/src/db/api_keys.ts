import type { Database as Db } from "better-sqlite3";

export interface ApiKeyRow {
  id: string;
  merchant_id: string;
  public_key: string;
  secret_hash: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface ApiKey {
  id: string;
  merchantId: string;
  publicKey: string;
  secretHash: string;
  label: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export interface CreateApiKeyInput {
  id: string;
  merchantId: string;
  publicKey: string;
  secretHash: string;
  label: string | null;
}

function toApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    publicKey: row.public_key,
    secretHash: row.secret_hash,
    label: row.label,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export function insertApiKey(db: Db, input: CreateApiKeyInput): ApiKey {
  db.prepare<[string, string, string, string, string | null]>(
    `INSERT INTO zettapay_api_keys (id, merchant_id, public_key, secret_hash, label)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.merchantId,
    input.publicKey,
    input.secretHash,
    input.label,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM zettapay_api_keys WHERE id = ?")
    .get(input.id) as ApiKeyRow | undefined;
  if (!row) {
    throw new Error("api key inserted but not retrievable");
  }
  return toApiKey(row);
}

export function findApiKeyBySecretHash(
  db: Db,
  secretHash: string,
): ApiKey | null {
  const row = db
    .prepare<[string]>("SELECT * FROM zettapay_api_keys WHERE secret_hash = ?")
    .get(secretHash) as ApiKeyRow | undefined;
  return row ? toApiKey(row) : null;
}

export function findApiKeyByPublicKey(
  db: Db,
  publicKey: string,
): ApiKey | null {
  const row = db
    .prepare<[string]>("SELECT * FROM zettapay_api_keys WHERE public_key = ?")
    .get(publicKey) as ApiKeyRow | undefined;
  return row ? toApiKey(row) : null;
}

export function listApiKeysForMerchant(db: Db, merchantId: string): ApiKey[] {
  const rows = db
    .prepare<[string]>(
      `SELECT * FROM zettapay_api_keys
       WHERE merchant_id = ?
       ORDER BY created_at DESC`,
    )
    .all(merchantId) as ApiKeyRow[];
  return rows.map(toApiKey);
}

/**
 * Soft-delete an API key. Returns true when the row was active and is now
 * revoked; returns false when the id is unknown or already revoked.
 */
export function revokeApiKey(db: Db, id: string): boolean {
  const result = db
    .prepare<[string]>(
      `UPDATE zettapay_api_keys
         SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id = ? AND revoked_at IS NULL`,
    )
    .run(id);
  return result.changes > 0;
}
