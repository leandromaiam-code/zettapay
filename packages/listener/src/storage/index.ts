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
import { StorageConfigError } from '../types.js';
import { JsonFileStorage } from './json.js';
import { SupabaseStorage } from './supabase.js';

export {
  MissingStorageDependencyError,
  StorageConfigError,
  StoragePersistenceError,
} from '../types.js';
export { JsonFileStorage } from './json.js';
export type { JsonFileStorageOptions } from './json.js';
export { SupabaseStorage } from './supabase.js';
export type { SupabaseStorageOptions } from './supabase.js';

export interface StorageAdapter {
  getMerchant(id: string): Promise<Merchant | null>;
  /** Lookup a merchant by email — used by the registration endpoint to
   * short-circuit duplicate inserts with a 200/already_exists response. */
  getMerchantByEmail(email: string): Promise<Merchant | null>;
  createMerchant(m: MerchantInput): Promise<Merchant>;

  createInvoice(inv: InvoiceInput): Promise<Invoice>;
  getInvoice(id: string): Promise<Invoice | null>;
  /** Reverse-lookup an invoice from its receive_address (BIP-84 child or
   * EVM checksummed). Returns the most recently created pending invoice
   * if multiple exist; `null` if none. Used by the watcher to map a
   * mempool/RPC event back to the originating invoice. */
  findInvoiceByAddress(address: string): Promise<Invoice | null>;
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
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
}

/**
 * Resolve a StorageAdapter from a kind discriminator. Z56 shipped the JSON
 * adapter; Z57 ships the Supabase adapter. SQLite / Postgres still throw
 * a clear not-yet-implemented error here.
 */
export async function createStorageAdapter(
  opts: StorageFactoryOptions,
): Promise<StorageAdapter> {
  switch (opts.kind) {
    case 'json':
      return new JsonFileStorage({ dataDir: opts.dataDir });
    case 'supabase': {
      if (!opts.supabaseUrl || !opts.supabaseServiceRoleKey) {
        throw new StorageConfigError(
          'supabase',
          'supabaseUrl and supabaseServiceRoleKey are required',
        );
      }
      return new SupabaseStorage({
        url: opts.supabaseUrl,
        serviceRoleKey: opts.supabaseServiceRoleKey,
      });
    }
    case 'sqlite':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${opts.kind}' not yet implemented (coming in Z58+). ` +
          `See docs/architecture/self-hosted-listener-design.md#3-dependency-graph`,
      );
    default: {
      const exhaustive: never = opts.kind;
      throw new Error(`@zettapay/listener: unknown storage kind '${exhaustive}'`);
    }
  }
}

/**
 * Env-driven factory used by serverless endpoints (Vercel) and the CLI
 * bootstrap (Z60). Default resolution:
 *
 *   - explicit `STORAGE=json|supabase|sqlite|postgres` wins
 *   - otherwise `supabase` if `SUPABASE_URL` is set, else `json`
 *
 * Throws `StorageConfigError` when 'supabase' is requested without the
 * required env credentials, so misconfigurations fail at boot rather than
 * surfacing as opaque 5xx later.
 */
export function createStorage(env: NodeJS.ProcessEnv = process.env): StorageAdapter {
  const explicit = (env.STORAGE ?? '').toLowerCase();
  const kindRaw =
    explicit ||
    (((env.SUPABASE_URL ?? '').trim().length > 0) ? 'supabase' : 'json');
  switch (kindRaw) {
    case 'json':
      return new JsonFileStorage({ dataDir: env.ZETTAPAY_DATA_DIR });
    case 'supabase': {
      const url = (env.SUPABASE_URL ?? '').trim();
      const key = (env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim();
      if (!url || !key) {
        throw new StorageConfigError(
          'supabase',
          'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required',
        );
      }
      return new SupabaseStorage({ url, serviceRoleKey: key });
    }
    case 'sqlite':
    case 'postgres':
      throw new Error(
        `@zettapay/listener: storage adapter '${kindRaw}' not yet implemented (coming in Z58+).`,
      );
    default:
      throw new Error(
        `@zettapay/listener: unknown STORAGE='${kindRaw}'. Expected one of: json, sqlite, supabase, postgres.`,
      );
  }
}
