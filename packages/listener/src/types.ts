export type Chain = 'btc' | 'polygon' | 'eth';

export type InvoiceStatus =
  | 'pending'
  | 'partial'
  | 'detected'
  | 'confirmed'
  | 'expired'
  | 'failed';

export interface Merchant {
  id: string;
  shop_name: string;
  email: string;
  xpub: string;
  webhook_url: string;
  webhook_secret_hash: string;
  next_child_index: number;
  created_at: string;
}

export type MerchantInput = Omit<Merchant, 'id' | 'next_child_index' | 'created_at'>;

/**
 * Canonical listener-core invoice. Z57 added a handful of OPTIONAL fields
 * (`receive_address`, `amount_usd`, `confirmations`, …) so the Supabase
 * adapter can faithfully round-trip the production `zettapay_invoices`
 * schema without forcing the JSON adapter to know about it. Adapters that
 * don't populate these fields simply omit them.
 */
export interface Invoice {
  id: string;
  merchant_id: string;
  chain: Chain;
  asset: string;
  amount: string;
  address: string;
  child_index: number | null;
  status: InvoiceStatus;
  expires_at: string;
  paid_at: string | null;
  tx_hash: string | null;
  created_at: string;
  updated_at: string;
  // Optional production-schema passthrough fields (Z57):
  receive_address?: string;
  amount_usd?: number | null;
  amount_btc?: string | null;
  required_confirmations?: number | null;
  confirmations?: number | null;
  detected_at?: string | null;
  confirmed_at?: string | null;
  metadata?: Record<string, unknown> | null;
}

export type InvoiceInput = Omit<
  Invoice,
  'created_at' | 'updated_at' | 'paid_at' | 'tx_hash' | 'status'
> & {
  status?: InvoiceStatus;
};

export interface WebhookEvent {
  id: string;
  invoice_id: string;
  payload_json: string;
  attempts: number;
  next_retry_at: string;
  delivered_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
}

export type WebhookEventInput = Omit<
  WebhookEvent,
  'attempts' | 'delivered_at' | 'last_status_code' | 'last_error'
>;

export interface WebhookDeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  nextRetryAt?: Date | null;
}

export interface ListPendingInvoicesOpts {
  limit?: number;
  chain?: Chain;
  order?: 'asc' | 'desc';
}

export type StorageKind = 'json' | 'sqlite' | 'supabase' | 'postgres';

export class MissingStorageDependencyError extends Error {
  readonly kind: StorageKind;
  readonly peer: string;
  constructor(kind: StorageKind, peer: string) {
    super(
      `@zettapay/listener: STORAGE=${kind} requires the optional peer dependency "${peer}". ` +
        `Install it with: npm install ${peer}`,
    );
    this.name = 'MissingStorageDependencyError';
    this.kind = kind;
    this.peer = peer;
  }
}

/**
 * Transport / persistence failures surfaced by remote adapters
 * (Supabase, Postgres). Endpoints map this to HTTP 502.
 */
export class StoragePersistenceError extends Error {
  readonly status: number;
  readonly body: string;
  readonly conflict: boolean;
  constructor(message: string, status: number, body: string) {
    super(message);
    this.name = 'StoragePersistenceError';
    this.status = status;
    this.body = body;
    this.conflict = status === 409;
  }
}

/**
 * Raised by adapters that need env config (Supabase, Postgres) when it is
 * missing or malformed. Distinct from `StoragePersistenceError` because it
 * happens *before* any network call — the caller misconfigured the runtime.
 */
export class StorageConfigError extends Error {
  readonly kind: StorageKind;
  constructor(kind: StorageKind, message: string) {
    super(`@zettapay/listener: storage='${kind}' misconfigured — ${message}`);
    this.name = 'StorageConfigError';
    this.kind = kind;
  }
}
