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
  applyAddOnColumns(db);
  dbInstance = db;
  return db;
}

function applyAddOnColumns(db: Db): void {
  // Idempotent column additions for forward-compat with older databases.
  const merchantCols = db.prepare("PRAGMA table_info(merchants)").all() as Array<{
    name: string;
  }>;
  const merchantNames = new Set(merchantCols.map((c) => c.name));
  if (!merchantNames.has("webhook_secret")) {
    db.exec("ALTER TABLE merchants ADD COLUMN webhook_secret TEXT");
  }
  if (!merchantNames.has("coinflow_enabled")) {
    db.exec(
      "ALTER TABLE merchants ADD COLUMN coinflow_enabled INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!merchantNames.has("coinflow_auto_settle")) {
    db.exec(
      "ALTER TABLE merchants ADD COLUMN coinflow_auto_settle INTEGER NOT NULL DEFAULT 0",
    );
  }
  if (!merchantNames.has("coinflow_merchant_id")) {
    db.exec("ALTER TABLE merchants ADD COLUMN coinflow_merchant_id TEXT");
  }
  if (!merchantNames.has("coinflow_bank_account_id")) {
    db.exec("ALTER TABLE merchants ADD COLUMN coinflow_bank_account_id TEXT");
  }
  if (!merchantNames.has("velocity_max_payments_per_minute")) {
    db.exec(
      "ALTER TABLE merchants ADD COLUMN velocity_max_payments_per_minute INTEGER NOT NULL DEFAULT 5",
    );
  }
  if (!merchantNames.has("velocity_max_amount_per_hour")) {
    db.exec(
      "ALTER TABLE merchants ADD COLUMN velocity_max_amount_per_hour REAL NOT NULL DEFAULT 1000",
    );
  }

  const paymentCols = db.prepare("PRAGMA table_info(payments)").all() as Array<{
    name: string;
  }>;
  const paymentNames = new Set(paymentCols.map((c) => c.name));
  if (!paymentNames.has("currency")) {
    db.exec(
      "ALTER TABLE payments ADD COLUMN currency TEXT NOT NULL DEFAULT 'USDC'",
    );
  }
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
      webhook_secret  TEXT,
      velocity_max_payments_per_minute INTEGER NOT NULL DEFAULT 5,
      velocity_max_amount_per_hour     REAL NOT NULL DEFAULT 1000,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS merchants_email_idx ON merchants(email);
    CREATE INDEX IF NOT EXISTS merchants_api_key_idx ON merchants(api_key);

    CREATE TABLE IF NOT EXISTS payments (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      amount_usdc     REAL NOT NULL,
      payer_wallet    TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed','refunded')),
      tx_signature    TEXT,
      error_message   TEXT,
      metadata_json   TEXT,
      currency        TEXT NOT NULL DEFAULT 'USDC',
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS payments_merchant_idx ON payments(merchant_id);
    CREATE INDEX IF NOT EXISTS payments_status_idx ON payments(status);
    CREATE INDEX IF NOT EXISTS payments_merchant_created_at_idx
      ON payments(merchant_id, created_at);
    CREATE INDEX IF NOT EXISTS payments_merchant_payer_created_at_idx
      ON payments(merchant_id, payer_wallet, created_at);
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

    CREATE TABLE IF NOT EXISTS webhook_events (
      id                 TEXT PRIMARY KEY,
      event_id           TEXT NOT NULL,
      url                TEXT NOT NULL,
      payload_json       TEXT NOT NULL,
      status             TEXT NOT NULL CHECK (status IN ('pending','sent','failed','dead')),
      attempt_count      INTEGER NOT NULL DEFAULT 0,
      max_attempts       INTEGER NOT NULL,
      last_attempt_at    TEXT,
      last_status_code   INTEGER,
      last_error         TEXT,
      dead_letter_reason TEXT,
      delivered_at       TEXT,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_event_id_uidx
      ON webhook_events(event_id);
    CREATE INDEX IF NOT EXISTS webhook_events_status_idx
      ON webhook_events(status);
    CREATE INDEX IF NOT EXISTS webhook_events_last_attempt_at_idx
      ON webhook_events(last_attempt_at);

    CREATE TABLE IF NOT EXISTS coinflow_settlements (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,
      amount_usdc     REAL NOT NULL,
      fee_usdc        REAL NOT NULL,
      net_usdc        REAL NOT NULL,
      fee_bps         INTEGER NOT NULL,
      bank_account_id TEXT NOT NULL,
      withdrawal_id   TEXT,
      status          TEXT NOT NULL CHECK (status IN ('pending','processing','completed','failed')),
      error_message   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      completed_at    TEXT
    );

    CREATE INDEX IF NOT EXISTS coinflow_settlements_merchant_idx
      ON coinflow_settlements(merchant_id);
    CREATE INDEX IF NOT EXISTS coinflow_settlements_status_idx
      ON coinflow_settlements(status);
    CREATE UNIQUE INDEX IF NOT EXISTS coinflow_settlements_payment_uidx
      ON coinflow_settlements(payment_id) WHERE payment_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS subscriptions (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      customer_wallet TEXT NOT NULL,
      amount          REAL NOT NULL CHECK (amount > 0),
      currency        TEXT NOT NULL DEFAULT 'USDC',
      interval        TEXT NOT NULL CHECK (interval IN ('daily','weekly','monthly')),
      status          TEXT NOT NULL CHECK (status IN ('active','paused','canceled')),
      next_charge_at  TEXT NOT NULL,
      last_charge_at  TEXT,
      metadata_json   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS subscriptions_merchant_idx
      ON subscriptions(merchant_id);
    CREATE INDEX IF NOT EXISTS subscriptions_status_idx
      ON subscriptions(status);
    CREATE INDEX IF NOT EXISTS subscriptions_next_charge_idx
      ON subscriptions(next_charge_at) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS subscriptions_customer_wallet_idx
      ON subscriptions(customer_wallet);
  `);
}
