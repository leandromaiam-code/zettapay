import Database, { type Database as Db } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

let dbInstance: Db | null = null;

export function openDatabase(databasePath: string): Db {
  if (dbInstance) return dbInstance;

  const isMemory = databasePath === ":memory:";
  const target = isMemory ? ":memory:" : resolve(databasePath);
  if (!isMemory) {
    mkdirSync(dirname(target), { recursive: true });
  }
  const db = new Database(target);
  if (!isMemory) {
    db.pragma("journal_mode = WAL");
  }
  db.pragma("foreign_keys = ON");
  applyMigrations(db);
  dbInstance = db;
  return db;
}

export function closeDatabase(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

function applyMigrations(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      wallet_address  TEXT NOT NULL UNIQUE,
      email           TEXT NOT NULL UNIQUE,
      api_key         TEXT NOT NULL UNIQUE,
      webhook_url     TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS merchants_email_idx ON merchants(email);

    CREATE TABLE IF NOT EXISTS payments (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      amount_usdc     REAL NOT NULL,
      payer_wallet    TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','refunded')),
      tx_signature    TEXT,
      error_message   TEXT,
      metadata_json   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS payments_merchant_idx ON payments(merchant_id);
    CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
    CREATE UNIQUE INDEX IF NOT EXISTS payments_tx_signature_uidx ON payments(tx_signature) WHERE tx_signature IS NOT NULL;

    CREATE TABLE IF NOT EXISTS audit_journal (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor       TEXT NOT NULL,
      event       TEXT NOT NULL,
      payload     TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS idempotency_keys (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      scope           TEXT NOT NULL,
      key             TEXT NOT NULL,
      request_hash    TEXT NOT NULL,
      response_status INTEGER NOT NULL,
      response_body   TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(scope, key)
    );

    CREATE INDEX IF NOT EXISTS idempotency_keys_created_at_idx
      ON idempotency_keys(created_at);
  `);
}
