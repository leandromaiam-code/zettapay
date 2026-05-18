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

export { MissingStorageDependencyError } from '../types.js';

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
 * Lazy factory. Concrete adapters land in Z56-Z59; here we only enforce the
 * contract that loading a non-default adapter triggers a dynamic import gated
 * on the matching optional peer dep (HR-OPTIONAL-DEPS).
 */
export async function createStorageAdapter(
  _opts: StorageFactoryOptions,
): Promise<StorageAdapter> {
  throw new Error(
    'createStorageAdapter: no adapter implemented in Z55. ' +
      'JSON adapter lands in Z56, SQLite in Z57, Supabase in Z58, Postgres in Z59. ' +
      'See docs/architecture/self-hosted-listener-design.md#3-dependency-graph',
  );
}
