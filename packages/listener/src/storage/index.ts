import { createRequire } from 'node:module';
import type {
  Invoice,
  InvoiceInput,
  InvoiceStatus,
  ListPendingInvoicesOpts,
  Merchant,
  MerchantInput,
  StorageKind,
  WebhookDeliveryResult,
  WebhookEvent,
  WebhookEventInput,
} from '../types.js';
import { MissingStorageDependencyError } from '../types.js';
import { JsonFileStorage } from './json.js';
import { SqliteStorage } from './sqlite.js';

export { MissingStorageDependencyError } from '../types.js';
export { JsonFileStorage } from './json.js';
export type { JsonFileStorageOptions } from './json.js';
export { SqliteStorage } from './sqlite.js';
export type { SqliteStorageOptions } from './sqlite.js';

export interface StorageAdapter {
  getMerchant(id: string): Promise<Merchant | null>;
  createMerchant(m: MerchantInput): Promise<Merchant>;

  createInvoice(inv: InvoiceInput): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>;
  listPendingInvoices(opts?: ListPendingInvoicesOpts): Promise<Invoice[]>;
  updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch?: Partial<Invoice>,
  ): Promise<Invoice>;

  recordWebhookEvent(evt: WebhookEventInput): Promise<WebhookEvent>;
  getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]>;
  markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void>;

  /** Atomic increment of merchant.next_child_index. MUST be race-safe. */
  nextChildIndex(merchantId: string): Promise<number>;

  /** Optional cleanup hook used by the contract test harness. */
  close?(): Promise<void>;
}

export interface BulkExport {
  merchant: Merchant | null;
  invoices: Invoice[];
  webhookEvents: WebhookEvent[];
}

export interface BulkImportInput {
  merchant?: Merchant;
  invoices?: Invoice[];
  webhookEvents?: WebhookEvent[];
}

export interface BulkImportResult {
  merchants: number;
  invoices: number;
  webhookEvents: number;
}

/**
 * Side-channel used by `zettapay-listener migrate` (Z60). Lets an adapter
 * dump and re-ingest *whole records* — preserving id, timestamps, counters —
 * so a json → sqlite → json round-trip is value-equivalent. Re-importing
 * already-present records is a no-op (UPSERT on `id`). NOT part of the
 * runtime listener-core surface; do not call from watcher/dispatcher code.
 */
export interface BulkPortable {
  exportAll(): Promise<BulkExport>;
  importBulk(data: BulkImportInput): Promise<BulkImportResult>;
}

export function isBulkPortable(s: StorageAdapter): s is StorageAdapter & BulkPortable {
  return (
    typeof (s as Partial<BulkPortable>).exportAll === 'function' &&
    typeof (s as Partial<BulkPortable>).importBulk === 'function'
  );
}

export interface StorageFactoryOptions {
  kind: StorageKind;
  dataDir?: string;
  connectionString?: string;
  /** SQLite-specific override; falls back to `<dataDir>/zettapay.db`. */
  sqliteFilename?: string;
}

/**
 * Resolve a StorageAdapter from a kind discriminator. Z56 ships JSON;
 * Z59 ships SQLite. Supabase / Postgres still throw a clear
 * not-yet-implemented error.
 */
export async function createStorageAdapter(
  opts: StorageFactoryOptions,
): Promise<StorageAdapter> {
  switch (opts.kind) {
    case 'json':
      return new JsonFileStorage({ dataDir: opts.dataDir });
    case 'sqlite':
      return new SqliteStorage({
        filename: opts.sqliteFilename,
        dataDir: opts.dataDir,
      });
    case 'supabase':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${opts.kind}' not yet implemented (coming in Z60+). ` +
          `See docs/architecture/self-hosted-listener-design.md#3-dependency-graph`,
      );
    default: {
      const exhaustive: never = opts.kind;
      throw new Error(`@zettapay/listener: unknown storage kind '${exhaustive}'`);
    }
  }
}

/**
 * Env-driven factory used by the CLI bootstrap (Z60). Reads `STORAGE`
 * (default `json`) + `ZETTAPAY_DATA_DIR` + `ZETTAPAY_SQLITE_FILE` and
 * instantiates the matching adapter. For SQLite the peer dep
 * `better-sqlite3` is checked eagerly so misconfigured deployments fail
 * fast with the exact `npm install better-sqlite3` hint.
 */
export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const kindRaw = (env.STORAGE ?? 'json').toLowerCase();
  switch (kindRaw) {
    case 'json':
      return new JsonFileStorage({ dataDir: env.ZETTAPAY_DATA_DIR });
    case 'sqlite': {
      try {
        createRequire(import.meta.url)('better-sqlite3');
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
      return new SqliteStorage({
        filename: env.ZETTAPAY_SQLITE_FILE,
        dataDir: env.ZETTAPAY_DATA_DIR,
      });
    }
    case 'supabase':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${kindRaw}' not yet implemented (coming in Z60+).`,
      );
    default:
      throw new Error(
        `@zettapay/listener: unknown STORAGE='${kindRaw}'. Expected one of: json, sqlite, supabase, postgres.`,
      );
  }
}
