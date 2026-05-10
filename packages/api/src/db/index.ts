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
  if (!paymentNames.has("agent_identity_id")) {
    // Z20.3: tag payments with the verified agent that initiated them so
    // per-agent spending caps can roll up by (merchant_id, agent_identity_id).
    db.exec(
      "ALTER TABLE payments ADD COLUMN agent_identity_id TEXT REFERENCES agent_identities(id) ON DELETE SET NULL",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS payments_merchant_agent_created_at_idx ON payments(merchant_id, agent_identity_id, created_at)",
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

    CREATE TABLE IF NOT EXISTS funnel_events (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      session_id      TEXT NOT NULL,
      event_type      TEXT NOT NULL CHECK (event_type IN ('view','checkout','completed')),
      payment_id      TEXT REFERENCES payments(id) ON DELETE SET NULL,
      metadata_json   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS funnel_events_merchant_idx
      ON funnel_events(merchant_id);
    CREATE INDEX IF NOT EXISTS funnel_events_merchant_created_at_idx
      ON funnel_events(merchant_id, created_at);
    CREATE INDEX IF NOT EXISTS funnel_events_merchant_type_created_at_idx
      ON funnel_events(merchant_id, event_type, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS funnel_events_session_type_uidx
      ON funnel_events(merchant_id, session_id, event_type);

    CREATE TABLE IF NOT EXISTS kyc_verifications (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL UNIQUE REFERENCES merchants(id) ON DELETE CASCADE,
      provider        TEXT NOT NULL CHECK (provider IN ('sumsub','persona')),
      external_id     TEXT,
      applicant_id    TEXT,
      level_name      TEXT,
      status          TEXT NOT NULL CHECK (status IN ('pending','in_review','approved','rejected','blocked')),
      review_answer   TEXT,
      review_reason   TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS kyc_verifications_status_idx
      ON kyc_verifications(status);
    CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_external_uidx
      ON kyc_verifications(provider, external_id) WHERE external_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS kyc_verifications_applicant_uidx
      ON kyc_verifications(provider, applicant_id) WHERE applicant_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS kyc_documents (
      id              TEXT PRIMARY KEY,
      verification_id TEXT NOT NULL REFERENCES kyc_verifications(id) ON DELETE CASCADE,
      doc_type        TEXT NOT NULL,
      doc_subtype     TEXT,
      file_name       TEXT,
      mime_type       TEXT,
      size_bytes      INTEGER,
      external_ref    TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS kyc_documents_verification_idx
      ON kyc_documents(verification_id);

    CREATE TABLE IF NOT EXISTS shopify_installations (
      id              TEXT PRIMARY KEY,
      shop_domain     TEXT NOT NULL UNIQUE,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE RESTRICT,
      access_token    TEXT,
      scope           TEXT,
      status          TEXT NOT NULL CHECK (status IN ('pending','installed','uninstalled')),
      oauth_nonce     TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      installed_at    TEXT,
      uninstalled_at  TEXT,
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS shopify_installations_merchant_idx
      ON shopify_installations(merchant_id);
    CREATE INDEX IF NOT EXISTS shopify_installations_status_idx
      ON shopify_installations(status);

    CREATE TABLE IF NOT EXISTS registry_tools (
      id              TEXT PRIMARY KEY,
      merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      slug            TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      description     TEXT NOT NULL,
      category        TEXT NOT NULL,
      endpoint_url    TEXT NOT NULL,
      price_usdc      REAL NOT NULL CHECK (price_usdc >= 0),
      currency        TEXT NOT NULL DEFAULT 'USDC',
      input_schema_json TEXT NOT NULL,
      tags_json       TEXT NOT NULL DEFAULT '[]',
      homepage_url    TEXT,
      docs_url        TEXT,
      icon_url        TEXT,
      status          TEXT NOT NULL CHECK (status IN ('draft','published','suspended')),
      install_count   INTEGER NOT NULL DEFAULT 0,
      call_count      INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS registry_tools_merchant_idx
      ON registry_tools(merchant_id);
    CREATE INDEX IF NOT EXISTS registry_tools_status_idx
      ON registry_tools(status);
    CREATE INDEX IF NOT EXISTS registry_tools_category_idx
      ON registry_tools(category);
    CREATE INDEX IF NOT EXISTS registry_tools_status_category_idx
      ON registry_tools(status, category);

    CREATE TABLE IF NOT EXISTS agent_identities (
      id              TEXT PRIMARY KEY,
      provider        TEXT NOT NULL,
      agent_id        TEXT NOT NULL,
      public_key      TEXT NOT NULL UNIQUE,
      display_name    TEXT,
      owner_email     TEXT,
      status          TEXT NOT NULL CHECK (status IN ('active','revoked')) DEFAULT 'active',
      registered_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS agent_identities_provider_agent_uidx
      ON agent_identities(provider, agent_id);
    CREATE INDEX IF NOT EXISTS agent_identities_status_idx
      ON agent_identities(status);

    CREATE TABLE IF NOT EXISTS agent_identity_nonces (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id  TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
      nonce        TEXT NOT NULL,
      used_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      UNIQUE(identity_id, nonce)
    );

    CREATE INDEX IF NOT EXISTS agent_identity_nonces_used_at_idx
      ON agent_identity_nonces(used_at);

    CREATE TABLE IF NOT EXISTS agent_spending_limits (
      id                 TEXT PRIMARY KEY,
      merchant_id        TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
      agent_identity_id  TEXT NOT NULL REFERENCES agent_identities(id) ON DELETE CASCADE,
      max_per_request    REAL,
      daily_cap          REAL,
      frozen             INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS agent_spending_limits_merchant_agent_uidx
      ON agent_spending_limits(merchant_id, agent_identity_id);
    CREATE INDEX IF NOT EXISTS agent_spending_limits_merchant_idx
      ON agent_spending_limits(merchant_id);
  `);
}
