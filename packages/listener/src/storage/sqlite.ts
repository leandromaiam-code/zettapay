import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import {
  InvoiceNotFoundError,
  MerchantNotInitializedError,
  WebhookEventNotFoundError,
} from '../errors.js';
import {
  type Invoice,
  type InvoiceInput,
  type InvoiceStatus,
  type ListPendingInvoicesOpts,
  type Merchant,
  type MerchantInput,
  MissingStorageDependencyError,
  type WebhookDeliveryResult,
  type WebhookEvent,
  type WebhookEventInput,
} from '../types.js';
import type {
  BulkExport,
  BulkImportInput,
  BulkImportResult,
  BulkPortable,
  StorageAdapter,
} from './index.js';

interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface StatementLike {
  run(...args: unknown[]): RunResult;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

interface DatabaseLike {
  prepare(sql: string): StatementLike;
  exec(sql: string): void;
  close(): void;
  pragma?(s: string): unknown;
}

type DatabaseConstructor = new (filename: string, opts?: object) => DatabaseLike;

export interface SqliteStorageOptions {
  /**
   * SQLite filename. `':memory:'` creates a per-connection in-memory DB
   * (useful for the contract test suite). When omitted, defaults to
   * `<dataDir>/zettapay.db` — where `dataDir` defaults to `~/.zettapay/data`.
   */
  filename?: string;
  /** Override the data directory used to resolve the default filename. */
  dataDir?: string;
  /**
   * Dependency-injected driver constructor — bypasses the lazy require of
   * `better-sqlite3`. Primarily intended for tests; production callers go
   * through `createStorage` / `createStorageAdapter`.
   */
  driver?: DatabaseConstructor;
  /** Pre-opened database handle. Mutually exclusive with `driver`/`filename`. */
  database?: DatabaseLike;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS merchants (
  id                   TEXT PRIMARY KEY,
  shop_name            TEXT NOT NULL,
  email                TEXT NOT NULL,
  xpub                 TEXT NOT NULL,
  webhook_url          TEXT NOT NULL,
  webhook_secret_hash  TEXT NOT NULL,
  next_child_index     INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL,
  chain         TEXT NOT NULL,
  asset         TEXT NOT NULL,
  amount        TEXT NOT NULL,
  address       TEXT NOT NULL,
  child_index   INTEGER,
  status        TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  paid_at       TEXT,
  tx_hash       TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status);
CREATE INDEX IF NOT EXISTS idx_invoices_chain ON invoices(chain);

CREATE TABLE IF NOT EXISTS webhook_events (
  id                TEXT PRIMARY KEY,
  invoice_id        TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_retry_at     TEXT NOT NULL,
  delivered_at      TEXT,
  last_status_code  INTEGER,
  last_error        TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_events_due
  ON webhook_events(delivered_at, next_retry_at);
`;

/**
 * Tier-2 storage adapter — ACID single-file SQLite via `better-sqlite3`.
 *
 * Schema column names and types are identical to the JSON adapter (see
 * `docs/architecture/self-hosted-listener-design.md#6-migration-story`) so
 * `migrate --from json --to sqlite` and the reverse are pure round-trips.
 *
 * `better-sqlite3` is an OPTIONAL peer dependency. The factory in
 * `./index.ts` lazy-requires it only when `STORAGE=sqlite` — listeners
 * running with `STORAGE=json` boot without it installed (HR-OPTIONAL-DEPS).
 */
export class SqliteStorage implements StorageAdapter, BulkPortable {
  private readonly opts: SqliteStorageOptions;
  private db: DatabaseLike | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(opts: SqliteStorageOptions = {}) {
    this.opts = opts;
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => this.doInit())();
    }
    return this.initPromise;
  }

  private doInit(): void {
    if (this.db) return;
    if (this.opts.database) {
      this.db = this.opts.database;
    } else {
      const Driver = this.opts.driver ?? loadDriverSync();
      const filename = this.resolveFilename();
      if (filename !== ':memory:') {
        fs.mkdirSync(path.dirname(filename), { recursive: true });
      }
      this.db = new Driver(filename);
    }
    if (this.db.pragma) {
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
    this.db.exec(SCHEMA_SQL);
  }

  private resolveFilename(): string {
    if (this.opts.filename) return this.opts.filename;
    const dataDir = this.opts.dataDir ?? path.join(os.homedir(), '.zettapay', 'data');
    return path.join(dataDir, 'zettapay.db');
  }

  private requireDb(): DatabaseLike {
    if (!this.db) {
      throw new Error('@zettapay/listener: SqliteStorage used before init()');
    }
    return this.db;
  }

  async getMerchant(id: string): Promise<Merchant | null> {
    await this.init();
    const row = this.requireDb()
      .prepare('SELECT * FROM merchants WHERE id = ?')
      .get(id);
    return row ? rowToMerchant(row as Record<string, unknown>) : null;
  }

  async createMerchant(input: MerchantInput): Promise<Merchant> {
    await this.init();
    const db = this.requireDb();
    const existing = db.prepare('SELECT * FROM merchants LIMIT 1').get();
    if (existing) return rowToMerchant(existing as Record<string, unknown>);
    const merchant: Merchant = {
      id: randomUUID(),
      shop_name: input.shop_name,
      email: input.email,
      xpub: input.xpub,
      webhook_url: input.webhook_url,
      webhook_secret_hash: input.webhook_secret_hash,
      next_child_index: 0,
      created_at: new Date().toISOString(),
    };
    db.prepare(
      `INSERT INTO merchants (id, shop_name, email, xpub, webhook_url, webhook_secret_hash, next_child_index, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      merchant.id,
      merchant.shop_name,
      merchant.email,
      merchant.xpub,
      merchant.webhook_url,
      merchant.webhook_secret_hash,
      merchant.next_child_index,
      merchant.created_at,
    );
    return merchant;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    await this.init();
    const id = input.id || `inv_${randomUUID()}`;
    const now = new Date().toISOString();
    const invoice: Invoice = {
      id,
      merchant_id: input.merchant_id,
      chain: input.chain,
      asset: input.asset,
      amount: input.amount,
      address: input.address,
      child_index: input.child_index,
      status: input.status ?? 'pending',
      expires_at: input.expires_at,
      paid_at: null,
      tx_hash: null,
      created_at: now,
      updated_at: now,
    };
    this.requireDb()
      .prepare(
        `INSERT INTO invoices (
          id, merchant_id, chain, asset, amount, address, child_index, status,
          expires_at, paid_at, tx_hash, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        invoice.id,
        invoice.merchant_id,
        invoice.chain,
        invoice.asset,
        invoice.amount,
        invoice.address,
        invoice.child_index,
        invoice.status,
        invoice.expires_at,
        invoice.paid_at,
        invoice.tx_hash,
        invoice.created_at,
        invoice.updated_at,
      );
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    await this.init();
    const row = this.requireDb()
      .prepare('SELECT * FROM invoices WHERE id = ?')
      .get(id);
    return row ? rowToInvoice(row as Record<string, unknown>) : null;
  }

  async listPendingInvoices(opts: ListPendingInvoicesOpts = {}): Promise<Invoice[]> {
    await this.init();
    const nowIso = new Date().toISOString();
    const params: unknown[] = [nowIso];
    let sql = `SELECT * FROM invoices WHERE status = 'pending' AND expires_at > ?`;
    if (opts.chain) {
      sql += ' AND chain = ?';
      params.push(opts.chain);
    }
    sql += ' ORDER BY created_at ASC';
    if (opts.limit && opts.limit > 0) {
      sql += ' LIMIT ?';
      params.push(opts.limit);
    }
    const rows = this.requireDb().prepare(sql).all(...params);
    return rows.map((r) => rowToInvoice(r as Record<string, unknown>));
  }

  async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch: Partial<Invoice> = {},
  ): Promise<Invoice> {
    await this.init();
    const db = this.requireDb();
    const currentRow = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
    if (!currentRow) throw new InvoiceNotFoundError(id);
    const current = rowToInvoice(currentRow as Record<string, unknown>);
    const merged: Invoice = {
      ...current,
      ...patch,
      id: current.id,
      merchant_id: current.merchant_id,
      created_at: current.created_at,
      status,
      updated_at: new Date().toISOString(),
    };
    db.prepare(
      `UPDATE invoices SET
         chain = ?, asset = ?, amount = ?, address = ?, child_index = ?,
         status = ?, expires_at = ?, paid_at = ?, tx_hash = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      merged.chain,
      merged.asset,
      merged.amount,
      merged.address,
      merged.child_index,
      merged.status,
      merged.expires_at,
      merged.paid_at,
      merged.tx_hash,
      merged.updated_at,
      merged.id,
    );
    return merged;
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<WebhookEvent> {
    await this.init();
    const event: WebhookEvent = {
      id: input.id,
      invoice_id: input.invoice_id,
      payload_json: input.payload_json,
      attempts: 0,
      next_retry_at: input.next_retry_at,
      delivered_at: null,
      last_status_code: null,
      last_error: null,
    };
    this.requireDb()
      .prepare(
        `INSERT INTO webhook_events (
          id, invoice_id, payload_json, attempts, next_retry_at,
          delivered_at, last_status_code, last_error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.invoice_id,
        event.payload_json,
        event.attempts,
        event.next_retry_at,
        event.delivered_at,
        event.last_status_code,
        event.last_error,
      );
    return event;
  }

  async getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    await this.init();
    const cutoff = now.toISOString();
    const params: unknown[] = [cutoff];
    let sql = `SELECT * FROM webhook_events
               WHERE delivered_at IS NULL AND next_retry_at <= ?
               ORDER BY next_retry_at ASC`;
    if (limit && limit > 0) {
      sql += ' LIMIT ?';
      params.push(limit);
    }
    const rows = this.requireDb().prepare(sql).all(...params);
    return rows.map((r) => rowToWebhookEvent(r as Record<string, unknown>));
  }

  async markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void> {
    await this.init();
    const db = this.requireDb();
    const currentRow = db.prepare('SELECT * FROM webhook_events WHERE id = ?').get(id);
    if (!currentRow) throw new WebhookEventNotFoundError(id);
    const current = rowToWebhookEvent(currentRow as Record<string, unknown>);
    const updated: WebhookEvent = {
      ...current,
      attempts: current.attempts + 1,
      delivered_at: result.ok ? new Date().toISOString() : current.delivered_at,
      last_status_code: result.statusCode ?? current.last_status_code,
      last_error: result.ok ? null : (result.error ?? current.last_error),
      next_retry_at: result.ok
        ? current.next_retry_at
        : result.nextRetryAt
          ? result.nextRetryAt.toISOString()
          : current.next_retry_at,
    };
    db.prepare(
      `UPDATE webhook_events SET
         attempts = ?, next_retry_at = ?, delivered_at = ?,
         last_status_code = ?, last_error = ?
       WHERE id = ?`,
    ).run(
      updated.attempts,
      updated.next_retry_at,
      updated.delivered_at,
      updated.last_status_code,
      updated.last_error,
      updated.id,
    );
  }

  async nextChildIndex(merchantId: string): Promise<number> {
    await this.init();
    const db = this.requireDb();
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db
        .prepare('SELECT next_child_index FROM merchants WHERE id = ?')
        .get(merchantId) as { next_child_index?: number } | undefined;
      if (!row || typeof row.next_child_index !== 'number') {
        throw new MerchantNotInitializedError(this.resolveFilename());
      }
      const current = row.next_child_index;
      db.prepare('UPDATE merchants SET next_child_index = ? WHERE id = ?').run(
        current + 1,
        merchantId,
      );
      db.exec('COMMIT');
      return current;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore — transaction may have been auto-rolled-back already
      }
      throw err;
    }
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // best-effort
      }
      this.db = null;
    }
    this.initPromise = null;
  }

  async exportAll(): Promise<BulkExport> {
    await this.init();
    const db = this.requireDb();
    const merchantRow = db.prepare('SELECT * FROM merchants LIMIT 1').get();
    const merchant = merchantRow ? rowToMerchant(merchantRow as Record<string, unknown>) : null;
    const invoiceRows = db.prepare('SELECT * FROM invoices').all();
    const invoices = invoiceRows.map((r) => rowToInvoice(r as Record<string, unknown>));
    const eventRows = db.prepare('SELECT * FROM webhook_events').all();
    const webhookEvents = eventRows.map((r) => rowToWebhookEvent(r as Record<string, unknown>));
    return { merchant, invoices, webhookEvents };
  }

  async importBulk(data: BulkImportInput): Promise<BulkImportResult> {
    await this.init();
    const db = this.requireDb();
    let merchants = 0;
    let invoices = 0;
    let webhookEvents = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      if (data.merchant) {
        const m = data.merchant;
        db.prepare(
          `INSERT INTO merchants (id, shop_name, email, xpub, webhook_url, webhook_secret_hash, next_child_index, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             shop_name = excluded.shop_name,
             email = excluded.email,
             xpub = excluded.xpub,
             webhook_url = excluded.webhook_url,
             webhook_secret_hash = excluded.webhook_secret_hash,
             next_child_index = excluded.next_child_index,
             created_at = excluded.created_at`,
        ).run(
          m.id,
          m.shop_name,
          m.email,
          m.xpub,
          m.webhook_url,
          m.webhook_secret_hash,
          m.next_child_index,
          m.created_at,
        );
        merchants = 1;
      }
      const upsertInvoice = db.prepare(
        `INSERT INTO invoices (id, merchant_id, chain, asset, amount, address, child_index, status,
                               expires_at, paid_at, tx_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           merchant_id = excluded.merchant_id,
           chain = excluded.chain,
           asset = excluded.asset,
           amount = excluded.amount,
           address = excluded.address,
           child_index = excluded.child_index,
           status = excluded.status,
           expires_at = excluded.expires_at,
           paid_at = excluded.paid_at,
           tx_hash = excluded.tx_hash,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`,
      );
      for (const inv of data.invoices ?? []) {
        upsertInvoice.run(
          inv.id,
          inv.merchant_id,
          inv.chain,
          inv.asset,
          inv.amount,
          inv.address,
          inv.child_index,
          inv.status,
          inv.expires_at,
          inv.paid_at,
          inv.tx_hash,
          inv.created_at,
          inv.updated_at,
        );
        invoices += 1;
      }
      const upsertEvent = db.prepare(
        `INSERT INTO webhook_events (id, invoice_id, payload_json, attempts, next_retry_at,
                                     delivered_at, last_status_code, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           invoice_id = excluded.invoice_id,
           payload_json = excluded.payload_json,
           attempts = excluded.attempts,
           next_retry_at = excluded.next_retry_at,
           delivered_at = excluded.delivered_at,
           last_status_code = excluded.last_status_code,
           last_error = excluded.last_error`,
      );
      for (const evt of data.webhookEvents ?? []) {
        upsertEvent.run(
          evt.id,
          evt.invoice_id,
          evt.payload_json,
          evt.attempts,
          evt.next_retry_at,
          evt.delivered_at,
          evt.last_status_code,
          evt.last_error,
        );
        webhookEvents += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
      throw err;
    }
    return { merchants, invoices, webhookEvents };
  }
}

function loadDriverSync(): DatabaseConstructor {
  try {
    const req = createRequire(import.meta.url);
    const mod = req('better-sqlite3') as DatabaseConstructor | { default: DatabaseConstructor };
    return (mod as { default?: DatabaseConstructor }).default ?? (mod as DatabaseConstructor);
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
    ) {
      throw new MissingStorageDependencyError('sqlite', 'better-sqlite3');
    }
    throw err;
  }
}

function rowToMerchant(row: Record<string, unknown>): Merchant {
  return {
    id: String(row.id),
    shop_name: String(row.shop_name),
    email: String(row.email),
    xpub: String(row.xpub),
    webhook_url: String(row.webhook_url),
    webhook_secret_hash: String(row.webhook_secret_hash),
    next_child_index: Number(row.next_child_index),
    created_at: String(row.created_at),
  };
}

function rowToInvoice(row: Record<string, unknown>): Invoice {
  return {
    id: String(row.id),
    merchant_id: String(row.merchant_id),
    chain: row.chain as Invoice['chain'],
    asset: String(row.asset),
    amount: String(row.amount),
    address: String(row.address),
    child_index: row.child_index === null || row.child_index === undefined ? null : Number(row.child_index),
    status: row.status as InvoiceStatus,
    expires_at: String(row.expires_at),
    paid_at: row.paid_at === null || row.paid_at === undefined ? null : String(row.paid_at),
    tx_hash: row.tx_hash === null || row.tx_hash === undefined ? null : String(row.tx_hash),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToWebhookEvent(row: Record<string, unknown>): WebhookEvent {
  return {
    id: String(row.id),
    invoice_id: String(row.invoice_id),
    payload_json: String(row.payload_json),
    attempts: Number(row.attempts),
    next_retry_at: String(row.next_retry_at),
    delivered_at: row.delivered_at === null || row.delivered_at === undefined ? null : String(row.delivered_at),
    last_status_code:
      row.last_status_code === null || row.last_status_code === undefined ? null : Number(row.last_status_code),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}
