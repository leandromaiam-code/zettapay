// SupabaseRestDb — a CloudDb backed by the shared Supabase project, reached
// through its PostgREST HTTP API with the service-role key (which bypasses RLS).
//
// We talk to the REST endpoint with plain `fetch` rather than pulling in
// @supabase/supabase-js. This keeps the package dependency-free, matches the
// pattern already used by @zettapay/receiver's store, and lets the self-hosted
// listener stay free of any Supabase peer dependency.
//
// NON-CUSTODIAL: the service-role key reads/writes invoice + merchant metadata
// only. No private key, seed, or signing material is stored or transmitted —
// the columns simply do not exist.

import type {
  CloudChain,
  CloudDb,
  InvoiceRow,
  ListPendingOpts,
  MerchantChainRow,
  MerchantKeyRow,
  MerchantRow,
  WebhookEventRow,
  WebhookRow,
} from './cloud-db.js';

const T = {
  merchants: 'zettapay_merchants',
  keys: 'zettapay_merchant_keys',
  chains: 'zettapay_merchant_chains',
  invoices: 'zettapay_invoices',
  webhooks: 'zettapay_webhooks',
  events: 'zettapay_webhook_events',
} as const;

export interface SupabaseRestDbOptions {
  url: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
}

export class SupabaseRestDb implements CloudDb {
  private readonly base: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SupabaseRestDbOptions) {
    if (!opts.url) throw new Error('@zettapay/cloud: SUPABASE_URL is required');
    if (!opts.serviceRoleKey) {
      throw new Error('@zettapay/cloud: SUPABASE_SERVICE_ROLE_KEY is required');
    }
    this.base = `${opts.url.replace(/\/$/, '')}/rest/v1`;
    this.key = opts.serviceRoleKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): SupabaseRestDb {
    return new SupabaseRestDb({
      url: env.SUPABASE_URL ?? '',
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY ?? '',
    });
  }

  private headers(prefer?: string): Record<string, string> {
    const h: Record<string, string> = {
      apikey: this.key,
      authorization: `Bearer ${this.key}`,
      'content-type': 'application/json',
    };
    if (prefer) h.prefer = prefer;
    return h;
  }

  private async request<T>(
    method: string,
    pathAndQuery: string,
    body?: unknown,
    prefer?: string,
  ): Promise<T[]> {
    const res = await this.fetchImpl(`${this.base}/${pathAndQuery}`, {
      method,
      headers: this.headers(prefer),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`@zettapay/cloud: supabase ${method} ${pathAndQuery} -> ${res.status} ${text}`);
    }
    if (res.status === 204) return [];
    const parsed = (await res.json().catch(() => [])) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [parsed as T];
  }

  private async selectOne<T>(table: string, query: string): Promise<T | null> {
    const rows = await this.request<T>('GET', `${table}?${query}&limit=1`);
    return rows[0] ?? null;
  }

  async getMerchant(id: string): Promise<MerchantRow | null> {
    return this.selectOne<MerchantRow>(T.merchants, `id=eq.${enc(id)}&select=*`);
  }

  async insertMerchant(row: MerchantRow): Promise<void> {
    await this.request('POST', T.merchants, row, 'return=minimal');
  }

  async getChains(merchantId: string): Promise<MerchantChainRow[]> {
    return this.request<MerchantChainRow>(
      'GET',
      `${T.chains}?merchant_id=eq.${enc(merchantId)}&select=*&order=created_at.asc`,
    );
  }

  async getChain(merchantId: string, chain: CloudChain): Promise<MerchantChainRow | null> {
    return this.selectOne<MerchantChainRow>(
      T.chains,
      `merchant_id=eq.${enc(merchantId)}&chain=eq.${enc(chain)}&select=*`,
    );
  }

  async insertChain(row: MerchantChainRow): Promise<void> {
    await this.request('POST', T.chains, row, 'return=minimal');
  }

  async casChildIndex(chainId: string, expected: number, next: number): Promise<boolean> {
    // A single conditional UPDATE: the WHERE clause pins the expected value, so
    // only one racing caller can match and advance it. PostgREST returns the
    // affected rows (return=representation); an empty array means the CAS lost.
    const rows = await this.request<MerchantChainRow>(
      'PATCH',
      `${T.chains}?id=eq.${enc(chainId)}&next_child_index=eq.${expected}`,
      { next_child_index: next },
      'return=representation',
    );
    return rows.length > 0;
  }

  async findActiveApiKey(hash: string): Promise<MerchantKeyRow | null> {
    return this.selectOne<MerchantKeyRow>(
      T.keys,
      `api_key_hash=eq.${enc(hash)}&revoked_at=is.null&select=*`,
    );
  }

  async insertApiKey(row: MerchantKeyRow): Promise<void> {
    await this.request('POST', T.keys, row, 'return=minimal');
  }

  async insertInvoice(row: InvoiceRow): Promise<void> {
    await this.request('POST', T.invoices, row, 'return=minimal');
  }

  async getInvoice(id: string): Promise<InvoiceRow | null> {
    return this.selectOne<InvoiceRow>(T.invoices, `id=eq.${enc(id)}&select=*`);
  }

  async countInvoicesSince(merchantId: string, sinceIso: string): Promise<number> {
    // HEAD + `count=exact` returns the total in Content-Range ("*/42" or
    // "0-0/42") without transferring any rows.
    const query = `${T.invoices}?merchant_id=eq.${enc(merchantId)}&created_at=gte.${enc(sinceIso)}&select=id`;
    const res = await this.fetchImpl(`${this.base}/${query}`, {
      method: 'HEAD',
      headers: { ...this.headers('count=exact'), range: '0-0' },
    });
    if (!res.ok && res.status !== 416) {
      throw new Error(`@zettapay/cloud: supabase HEAD ${T.invoices} -> ${res.status}`);
    }
    const total = Number((res.headers.get('content-range') ?? '').split('/')[1]);
    if (!Number.isFinite(total)) {
      throw new Error('@zettapay/cloud: supabase did not return an invoice count');
    }
    return total;
  }

  async listPendingInvoices(opts: ListPendingOpts): Promise<InvoiceRow[]> {
    let q = `status=eq.pending&expires_at=gt.${enc(opts.nowIso)}&select=*`;
    if (opts.chain) q += `&chain=eq.${enc(opts.chain)}`;
    if (opts.limit) q += `&limit=${opts.limit}`;
    return this.request<InvoiceRow>('GET', `${T.invoices}?${q}`);
  }

  async updateInvoice(id: string, patch: Partial<InvoiceRow>): Promise<InvoiceRow | null> {
    const rows = await this.request<InvoiceRow>(
      'PATCH',
      `${T.invoices}?id=eq.${enc(id)}`,
      patch,
      'return=representation',
    );
    return rows[0] ?? null;
  }

  async getWebhook(merchantId: string): Promise<WebhookRow | null> {
    return this.selectOne<WebhookRow>(
      T.webhooks,
      `merchant_id=eq.${enc(merchantId)}&select=*&order=created_at.asc`,
    );
  }

  async insertWebhook(row: WebhookRow): Promise<void> {
    await this.request('POST', T.webhooks, row, 'return=minimal');
  }

  async insertWebhookEvent(row: WebhookEventRow): Promise<void> {
    await this.request('POST', T.events, row, 'return=minimal');
  }

  async getWebhookEvent(id: string): Promise<WebhookEventRow | null> {
    return this.selectOne<WebhookEventRow>(T.events, `id=eq.${enc(id)}&select=*`);
  }

  async getDueWebhookEvents(nowIso: string, limit: number): Promise<WebhookEventRow[]> {
    return this.request<WebhookEventRow>(
      'GET',
      `${T.events}?delivered_at=is.null&next_attempt_at=lte.${enc(nowIso)}&select=*&order=next_attempt_at.asc&limit=${limit}`,
    );
  }

  async updateWebhookEvent(id: string, patch: Partial<WebhookEventRow>): Promise<void> {
    await this.request('PATCH', `${T.events}?id=eq.${enc(id)}`, patch, 'return=minimal');
  }
}

function enc(v: string): string {
  return encodeURIComponent(v);
}
