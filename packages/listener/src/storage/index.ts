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
import { JsonFileStorage } from './json.js';

export { MissingStorageDependencyError } from '../types.js';
export { JsonFileStorage } from './json.js';
export type { JsonFileStorageOptions } from './json.js';

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

export interface StorageFactoryOptions {
  kind: StorageKind;
  dataDir?: string;
  connectionString?: string;
}

/**
 * Resolve a StorageAdapter from a kind discriminator. Z56 ships the JSON
 * adapter; SQLite / Supabase / Postgres land in Z57+ and throw a clear
 * not-yet-implemented error here.
 */
export async function createStorageAdapter(
  opts: StorageFactoryOptions,
): Promise<StorageAdapter> {
  switch (opts.kind) {
    case 'json':
      return new JsonFileStorage({ dataDir: opts.dataDir });
    case 'sqlite':
    case 'supabase':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${opts.kind}' not yet implemented (coming in Z57+). ` +
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
 * (default `json`) + `ZETTAPAY_DATA_DIR` and instantiates the matching
 * adapter synchronously.
 */
export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const kindRaw = (env.STORAGE ?? 'json').toLowerCase();
  switch (kindRaw) {
    case 'json':
      return new JsonFileStorage({ dataDir: env.ZETTAPAY_DATA_DIR });
    case 'sqlite':
    case 'supabase':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${kindRaw}' not yet implemented (coming in Z57+).`,
      );
    default:
      throw new Error(
        `@zettapay/listener: unknown STORAGE='${kindRaw}'. Expected one of: json, sqlite, supabase, postgres.`,
      );
  }
}
