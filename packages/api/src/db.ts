import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS merchants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT    NOT NULL,
  wallet_pubkey TEXT    NOT NULL UNIQUE,
  usdc_ata      TEXT    NOT NULL UNIQUE,
  created_at    INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE INDEX IF NOT EXISTS idx_merchants_wallet_pubkey ON merchants(wallet_pubkey);
CREATE INDEX IF NOT EXISTS idx_merchants_created_at    ON merchants(created_at);
`;

export interface OpenDbOptions {
  filename?: string;
  readonly?: boolean;
}

export function openDb(options: OpenDbOptions = {}): DB {
  const filename = options.filename ?? process.env.ZETTAPAY_DB_PATH ?? './data/zettapay.sqlite';

  if (filename !== ':memory:') {
    mkdirSync(dirname(filename), { recursive: true });
  }

  const db = new Database(filename, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
