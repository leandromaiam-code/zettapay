// Row shapes that mirror the shared `zettapay_*` Supabase tables 1-for-1, plus
// the CloudDb gateway the rest of the package talks to. Keeping a narrow gateway
// (instead of reaching for a Supabase client everywhere) lets the watcher fleet,
// the API server and the storage adapter share one persistence surface — and
// lets the test suite swap in a deterministic in-memory implementation with zero
// network. NON-CUSTODIAL: only public material (xpub / receive address / webhook
// HMAC secret) is ever persisted; no private key, seed or signing path exists.

export type CloudChain = 'btc' | 'base';

export interface MerchantRow {
  id: string;
  auth_uid: string | null;
  email: string;
  name: string;
  created_at: string;
}

export interface MerchantKeyRow {
  id: string;
  merchant_id: string;
  api_key_hash: string;
  key_prefix: string;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface MerchantChainRow {
  id: string;
  merchant_id: string;
  chain: CloudChain;
  xpub: string | null;
  fixed_address: string | null;
  evm_tokens: string[] | null;
  next_child_index: number;
  created_at: string;
}

export interface InvoiceRow {
  id: string;
  merchant_id: string;
  chain: string;
  asset: string;
  amount_sats: number | null;
  amount_units: string | null;
  amount_usd: number | null;
  address: string;
  child_index: number | null;
  nonce: number | null;
  status: string;
  tx_hash: string | null;
  expires_at: string;
  created_at: string;
  paid_at: string | null;
}

export interface WebhookRow {
  id: string;
  merchant_id: string;
  url: string;
  secret_enc: string;
  created_at: string;
}

export interface WebhookEventRow {
  id: string;
  invoice_id: string;
  merchant_id: string;
  event_type: string;
  payload: unknown;
  hmac: string | null;
  attempts: number;
  next_attempt_at: string;
  delivered_at: string | null;
  created_at: string;
}

export interface ListPendingOpts {
  chain?: string;
  limit?: number;
  /** ISO timestamp; only invoices expiring strictly after this are returned. */
  nowIso: string;
}

/**
 * The persistence contract every cloud backend implements. `SupabaseRestDb`
 * fulfils it against the shared Supabase project via the PostgREST API; the
 * `MemoryCloudDb` below fulfils it in-process for tests/dev.
 */
export interface CloudDb {
  getMerchant(id: string): Promise<MerchantRow | null>;
  insertMerchant(row: MerchantRow): Promise<void>;

  getChains(merchantId: string): Promise<MerchantChainRow[]>;
  getChain(merchantId: string, chain: CloudChain): Promise<MerchantChainRow | null>;
  insertChain(row: MerchantChainRow): Promise<void>;
  /**
   * Atomic compare-and-set of a chain's `next_child_index`. Returns true only
   * when the stored value still equalled `expected` (and was advanced to
   * `next`). Two concurrent callers can never both observe the same index.
   */
  casChildIndex(chainId: string, expected: number, next: number): Promise<boolean>;

  findActiveApiKey(hash: string): Promise<MerchantKeyRow | null>;
  insertApiKey(row: MerchantKeyRow): Promise<void>;

  insertInvoice(row: InvoiceRow): Promise<void>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  listPendingInvoices(opts: ListPendingOpts): Promise<InvoiceRow[]>;
  updateInvoice(id: string, patch: Partial<InvoiceRow>): Promise<InvoiceRow | null>;

  getWebhook(merchantId: string): Promise<WebhookRow | null>;
  insertWebhook(row: WebhookRow): Promise<void>;

  insertWebhookEvent(row: WebhookEventRow): Promise<void>;
  getWebhookEvent(id: string): Promise<WebhookEventRow | null>;
  getDueWebhookEvents(nowIso: string, limit: number): Promise<WebhookEventRow[]>;
  updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void>;
}

/**
 * In-memory CloudDb for tests and local dev. CRUD lives in plain Maps. The
 * compare-and-set in `casChildIndex` is synchronous within the promise body
 * (no `await` between the read and the write), so it is a true atomic primitive
 * even under heavy `Promise.all` concurrency — exactly the guarantee a real
 * `UPDATE ... WHERE next_child_index = $expected` gives us.
 */
export class MemoryCloudDb implements CloudDb {
  private readonly merchants = new Map<string, MerchantRow>();
  private readonly chains = new Map<string, MerchantChainRow>();
  private readonly keys = new Map<string, MerchantKeyRow>();
  private readonly invoices = new Map<string, InvoiceRow>();
  private readonly webhooks = new Map<string, WebhookRow>();
  private readonly events = new Map<string, WebhookEventRow>();

  async getMerchant(id: string): Promise<MerchantRow | null> {
    return this.merchants.get(id) ?? null;
  }

  async insertMerchant(row: MerchantRow): Promise<void> {
    this.merchants.set(row.id, { ...row });
  }

  async getChains(merchantId: string): Promise<MerchantChainRow[]> {
    return [...this.chains.values()]
      .filter((c) => c.merchant_id === merchantId)
      .map((c) => ({ ...c }));
  }

  async getChain(merchantId: string, chain: CloudChain): Promise<MerchantChainRow | null> {
    const found = [...this.chains.values()].find(
      (c) => c.merchant_id === merchantId && c.chain === chain,
    );
    return found ? { ...found } : null;
  }

  async insertChain(row: MerchantChainRow): Promise<void> {
    this.chains.set(row.id, { ...row });
  }

  async casChildIndex(chainId: string, expected: number, next: number): Promise<boolean> {
    const row = this.chains.get(chainId);
    if (!row || row.next_child_index !== expected) return false;
    row.next_child_index = next;
    return true;
  }

  async findActiveApiKey(hash: string): Promise<MerchantKeyRow | null> {
    const found = [...this.keys.values()].find(
      (k) => k.api_key_hash === hash && k.revoked_at === null,
    );
    return found ? { ...found } : null;
  }

  async insertApiKey(row: MerchantKeyRow): Promise<void> {
    this.keys.set(row.id, { ...row });
  }

  async insertInvoice(row: InvoiceRow): Promise<void> {
    this.invoices.set(row.id, { ...row });
  }

  async getInvoice(id: string): Promise<InvoiceRow | null> {
    const row = this.invoices.get(id);
    return row ? { ...row } : null;
  }

  async listPendingInvoices(opts: ListPendingOpts): Promise<InvoiceRow[]> {
    const cutoff = Date.parse(opts.nowIso);
    const out: InvoiceRow[] = [];
    for (const row of this.invoices.values()) {
      if (row.status !== 'pending') continue;
      if (Date.parse(row.expires_at) <= cutoff) continue;
      if (opts.chain && row.chain !== opts.chain) continue;
      out.push({ ...row });
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  async updateInvoice(id: string, patch: Partial<InvoiceRow>): Promise<InvoiceRow | null> {
    const row = this.invoices.get(id);
    if (!row) return null;
    const merged = { ...row, ...patch, id: row.id, merchant_id: row.merchant_id };
    this.invoices.set(id, merged);
    return { ...merged };
  }

  async getWebhook(merchantId: string): Promise<WebhookRow | null> {
    const found = [...this.webhooks.values()].find((w) => w.merchant_id === merchantId);
    return found ? { ...found } : null;
  }

  async insertWebhook(row: WebhookRow): Promise<void> {
    this.webhooks.set(row.id, { ...row });
  }

  async insertWebhookEvent(row: WebhookEventRow): Promise<void> {
    this.events.set(row.id, { ...row });
  }

  async getWebhookEvent(id: string): Promise<WebhookEventRow | null> {
    const row = this.events.get(id);
    return row ? { ...row } : null;
  }

  async getDueWebhookEvents(nowIso: string, limit: number): Promise<WebhookEventRow[]> {
    const cutoff = Date.parse(nowIso);
    const out: WebhookEventRow[] = [];
    for (const row of this.events.values()) {
      if (row.delivered_at) continue;
      if (Date.parse(row.next_attempt_at) > cutoff) continue;
      out.push({ ...row });
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  async updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void> {
    const row = this.events.get(id);
    if (!row) return;
    this.events.set(id, { ...row, ...patch, id: row.id });
  }
}
