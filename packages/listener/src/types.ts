export type Chain = 'btc' | 'polygon' | 'eth';

export type InvoiceStatus =
  | 'pending'
  | 'partial'
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
