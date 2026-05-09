import type { Database as Db } from "better-sqlite3";

export interface MerchantRow {
  id: string;
  name: string;
  wallet_address: string;
  email: string;
  api_key: string;
  webhook_url: string | null;
  created_at: string;
}

export interface Merchant {
  id: string;
  name: string;
  walletAddress: string;
  email: string;
  apiKey: string;
  webhookUrl: string | null;
  createdAt: string;
}

export interface CreateMerchantInput {
  id: string;
  name: string;
  walletAddress: string;
  email: string;
  apiKey: string;
  webhookUrl: string | null;
}

function toMerchant(row: MerchantRow): Merchant {
  return {
    id: row.id,
    name: row.name,
    walletAddress: row.wallet_address,
    email: row.email,
    apiKey: row.api_key,
    webhookUrl: row.webhook_url,
    createdAt: row.created_at,
  };
}

export function insertMerchant(db: Db, input: CreateMerchantInput): Merchant {
  const stmt = db.prepare<[string, string, string, string, string, string | null]>(
    `INSERT INTO merchants (id, name, wallet_address, email, api_key, webhook_url)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  stmt.run(
    input.id,
    input.name,
    input.walletAddress,
    input.email,
    input.apiKey,
    input.webhookUrl,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE id = ?")
    .get(input.id) as MerchantRow | undefined;
  if (!row) {
    throw new Error("merchant inserted but not retrievable");
  }
  return toMerchant(row);
}

export function findMerchantById(db: Db, id: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE id = ?")
    .get(id) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByEmail(db: Db, email: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE email = ?")
    .get(email) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}

export function findMerchantByWallet(db: Db, walletAddress: string): Merchant | null {
  const row = db
    .prepare<[string]>("SELECT * FROM merchants WHERE wallet_address = ?")
    .get(walletAddress) as MerchantRow | undefined;
  return row ? toMerchant(row) : null;
}
