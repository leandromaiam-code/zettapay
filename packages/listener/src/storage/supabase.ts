// SupabaseStorage — StorageAdapter backed by Supabase's PostgREST API via
// plain `fetch`. We intentionally do NOT depend on the official Supabase
// JS SDK (HR-OPTIONAL-DEPS): self-hosted listener users should be able to
// install `@zettapay/listener` without pulling ~150 KB of SDK they may
// never use.
//
// Schema mapping (production `zettapay_invoices` / `zettapay_merchants` ↔
// listener canonical fields, see
// docs/architecture/self-hosted-listener-design.md#6-migration-story):
//
//   invoice.address          ↔ receive_address column
//   invoice.amount           ↔ amount_btc column (string, chain=btc)
//   invoice.asset            ↔ derived from chain (BTC | USDC)
//   invoice.paid_at          ↔ confirmed_at column
//   merchant.webhook_secret_hash ↔ webhook_secret column (plain hex)
//
// All optional production-only fields (amount_usd, confirmations,
// detected_at, metadata, …) are surfaced as Invoice/Merchant optional
// fields so endpoints can faithfully reproduce their HTTP responses.

import {
  StorageConfigError,
  StoragePersistenceError,
  type Chain,
  type Invoice,
  type InvoiceInput,
  type InvoiceStatus,
  type ListPendingInvoicesOpts,
  type Merchant,
  type MerchantInput,
  type WebhookDeliveryResult,
  type WebhookEvent,
  type WebhookEventInput,
} from '../types.js';
import type { StorageAdapter } from './index.js';

export interface SupabaseStorageOptions {
  url: string;
  serviceRoleKey: string;
  /** Override `globalThis.fetch` for tests. */
  fetchImpl?: typeof fetch;
  /** Override `() => new Date().toISOString()` for deterministic tests. */
  nowIso?: () => string;
  /** Tables names — overridable so callers on a custom schema can opt in. */
  tables?: {
    merchants?: string;
    invoices?: string;
    webhookEvents?: string;
  };
}

interface RestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  query?: Record<string, string | undefined>;
  body?: unknown;
  prefer?: string;
}

interface MerchantRow {
  id: string;
  email: string;
  shop_name: string;
  xpub: string;
  webhook_url: string | null;
  webhook_secret: string | null;
  next_child_index: number;
  created_at: string;
}

interface InvoiceRow {
  id: string;
  merchant_id: string;
  chain: string;
  child_index: number | null;
  receive_address: string;
  amount_usd: number | string | null;
  amount_btc: string | null;
  required_confirmations: number | null;
  status: string;
  confirmations: number | null;
  tx_hash: string | null;
  detected_at: string | null;
  confirmed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string | null;
  metadata: Record<string, unknown> | null;
}

interface WebhookRow {
  id: string;
  invoice_id: string;
  payload_json: string | null;
  payload: Record<string, unknown> | null;
  attempts: number | null;
  next_retry_at: string;
  delivered_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
}

const DEFAULT_TABLES = {
  merchants: 'zettapay_merchants',
  invoices: 'zettapay_invoices',
  webhookEvents: 'zettapay_webhook_events',
} as const;

function assetForChain(chain: string): string {
  if (chain === 'btc') return 'BTC';
  return 'USDC';
}

function normalizeChain(value: string): Chain {
  if (value === 'btc' || value === 'polygon' || value === 'eth') return value;
  return 'btc';
}

function normalizeStatus(value: string): InvoiceStatus {
  if (
    value === 'pending' ||
    value === 'partial' ||
    value === 'detected' ||
    value === 'confirmed' ||
    value === 'expired' ||
    value === 'failed'
  ) {
    return value;
  }
  return 'pending';
}

export class SupabaseStorage implements StorageAdapter {
  private readonly url: string;
  private readonly key: string;
  private readonly fetchImpl: typeof fetch;
  private readonly nowIso: () => string;
  private readonly merchantsTable: string;
  private readonly invoicesTable: string;
  private readonly webhookEventsTable: string;

  constructor(opts: SupabaseStorageOptions) {
    if (!opts.url || !opts.serviceRoleKey) {
      throw new StorageConfigError(
        'supabase',
        'url and serviceRoleKey must be non-empty strings',
      );
    }
    this.url = opts.url.replace(/\/+$/, '');
    this.key = opts.serviceRoleKey;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.nowIso = opts.nowIso ?? (() => new Date().toISOString());
    this.merchantsTable = opts.tables?.merchants ?? DEFAULT_TABLES.merchants;
    this.invoicesTable = opts.tables?.invoices ?? DEFAULT_TABLES.invoices;
    this.webhookEventsTable = opts.tables?.webhookEvents ?? DEFAULT_TABLES.webhookEvents;
  }

  // ---------------------------------------------------------------------
  // REST plumbing
  // ---------------------------------------------------------------------

  private async rest<T>(path: string, opts: RestOptions = {}): Promise<T> {
    const url = new URL(`${this.url}/rest/v1/${path.replace(/^\/+/, '')}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      apikey: this.key,
      Authorization: `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (opts.prefer) headers['Prefer'] = opts.prefer;
    const init: RequestInit = {
      method: opts.method ?? 'GET',
      headers,
    };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }
    const res = await this.fetchImpl(url.toString(), init);
    const text = await res.text();
    if (!res.ok) {
      throw new StoragePersistenceError(
        `supabase ${opts.method ?? 'GET'} ${path} failed: ${res.status}`,
        res.status,
        text,
      );
    }
    if (text.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new StoragePersistenceError(
        `supabase response not JSON: ${(err as Error).message}`,
        res.status,
        text,
      );
    }
  }

  // ---------------------------------------------------------------------
  // Merchants
  // ---------------------------------------------------------------------

  async getMerchant(id: string): Promise<Merchant | null> {
    const rows = await this.rest<MerchantRow[]>(this.merchantsTable, {
      query: { id: `eq.${id}`, limit: '1' },
    });
    return rows[0] ? this.mapMerchant(rows[0]) : null;
  }

  async getMerchantByEmail(email: string): Promise<Merchant | null> {
    const normalized = email.trim().toLowerCase();
    const rows = await this.rest<MerchantRow[]>(this.merchantsTable, {
      query: { email: `eq.${normalized}`, limit: '1' },
    });
    return rows[0] ? this.mapMerchant(rows[0]) : null;
  }

  async createMerchant(input: MerchantInput): Promise<Merchant> {
    const row = {
      email: input.email.trim().toLowerCase(),
      shop_name: input.shop_name,
      xpub: input.xpub,
      webhook_url: input.webhook_url || null,
      webhook_secret: input.webhook_secret_hash || null,
    };
    try {
      const inserted = await this.rest<MerchantRow[]>(this.merchantsTable, {
        method: 'POST',
        body: row,
        prefer: 'return=representation',
      });
      if (!inserted[0]) {
        throw new StoragePersistenceError('supabase insert returned no rows', 500, '');
      }
      return this.mapMerchant(inserted[0]);
    } catch (err) {
      if (err instanceof StoragePersistenceError && err.conflict) {
        const existing = await this.getMerchantByEmail(row.email);
        if (existing) return existing;
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------
  // Invoices
  // ---------------------------------------------------------------------

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const row: Record<string, unknown> = {
      id: input.id,
      merchant_id: input.merchant_id,
      chain: input.chain,
      child_index: input.child_index,
      receive_address: input.receive_address ?? input.address,
      amount_btc: input.amount_btc ?? (input.chain === 'btc' ? input.amount : null),
      status: input.status ?? 'pending',
      expires_at: input.expires_at,
    };
    if (input.amount_usd !== undefined) row.amount_usd = input.amount_usd;
    if (input.required_confirmations !== undefined) {
      row.required_confirmations = input.required_confirmations;
    }
    if (input.metadata !== undefined) row.metadata = input.metadata ?? null;
    const inserted = await this.rest<InvoiceRow[]>(this.invoicesTable, {
      method: 'POST',
      body: row,
      prefer: 'return=representation',
    });
    if (!inserted[0]) {
      throw new StoragePersistenceError('supabase insert returned no rows', 500, '');
    }
    return this.mapInvoice(inserted[0]);
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const rows = await this.rest<InvoiceRow[]>(this.invoicesTable, {
      query: { id: `eq.${id}`, limit: '1' },
    });
    return rows[0] ? this.mapInvoice(rows[0]) : null;
  }

  async findInvoiceByAddress(address: string): Promise<Invoice | null> {
    const rows = await this.rest<InvoiceRow[]>(this.invoicesTable, {
      query: {
        receive_address: `eq.${address}`,
        limit: '1',
        order: 'created_at.desc',
      },
    });
    return rows[0] ? this.mapInvoice(rows[0]) : null;
  }

  async listPendingInvoices(opts: ListPendingInvoicesOpts = {}): Promise<Invoice[]> {
    const query: Record<string, string> = {
      status: 'eq.pending',
      expires_at: `gt.${this.nowIso()}`,
      order: opts.order === 'desc' ? 'created_at.desc' : 'created_at.asc',
    };
    if (opts.chain) query.chain = `eq.${opts.chain}`;
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    const rows = await this.rest<InvoiceRow[]>(this.invoicesTable, { query });
    return rows.map((r) => this.mapInvoice(r));
  }

  async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch: Partial<Invoice> = {},
  ): Promise<Invoice> {
    const dbPatch: Record<string, unknown> = {
      status,
      updated_at: this.nowIso(),
    };
    if (patch.tx_hash !== undefined) dbPatch.tx_hash = patch.tx_hash;
    if (patch.paid_at !== undefined) dbPatch.confirmed_at = patch.paid_at;
    if (patch.confirmations !== undefined) dbPatch.confirmations = patch.confirmations;
    if (patch.detected_at !== undefined) dbPatch.detected_at = patch.detected_at;
    if (patch.confirmed_at !== undefined) dbPatch.confirmed_at = patch.confirmed_at;
    if (patch.metadata !== undefined) dbPatch.metadata = patch.metadata;
    const updated = await this.rest<InvoiceRow[]>(this.invoicesTable, {
      method: 'PATCH',
      query: { id: `eq.${id}` },
      body: dbPatch,
      prefer: 'return=representation',
    });
    if (!updated[0]) {
      throw new StoragePersistenceError(
        `supabase update returned no rows for invoice "${id}"`,
        404,
        '',
      );
    }
    return this.mapInvoice(updated[0]);
  }

  // ---------------------------------------------------------------------
  // Webhook events
  // ---------------------------------------------------------------------

  async recordWebhookEvent(input: WebhookEventInput): Promise<WebhookEvent> {
    const row = {
      id: input.id,
      invoice_id: input.invoice_id,
      payload_json: input.payload_json,
      next_retry_at: input.next_retry_at,
      attempts: 0,
    };
    const inserted = await this.rest<WebhookRow[]>(this.webhookEventsTable, {
      method: 'POST',
      body: row,
      prefer: 'return=representation',
    });
    if (!inserted[0]) {
      throw new StoragePersistenceError(
        'supabase insert returned no webhook event row',
        500,
        '',
      );
    }
    return this.mapWebhookEvent(inserted[0]);
  }

  async getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    const rows = await this.rest<WebhookRow[]>(this.webhookEventsTable, {
      query: {
        next_retry_at: `lte.${now.toISOString()}`,
        delivered_at: 'is.null',
        limit: String(limit),
        order: 'next_retry_at.asc',
      },
    });
    return rows.map((r) => this.mapWebhookEvent(r));
  }

  async markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void> {
    const rows = await this.rest<WebhookRow[]>(this.webhookEventsTable, {
      query: { id: `eq.${id}`, limit: '1' },
    });
    const current = rows[0];
    if (!current) {
      throw new StoragePersistenceError(
        `supabase webhook event "${id}" not found`,
        404,
        '',
      );
    }
    const dbPatch: Record<string, unknown> = {
      attempts: (current.attempts ?? 0) + 1,
      last_status_code: result.statusCode ?? current.last_status_code,
    };
    if (result.ok) {
      dbPatch.delivered_at = this.nowIso();
      dbPatch.last_error = null;
    } else {
      dbPatch.last_error = result.error ?? current.last_error;
      if (result.nextRetryAt) dbPatch.next_retry_at = result.nextRetryAt.toISOString();
    }
    await this.rest<WebhookRow[]>(this.webhookEventsTable, {
      method: 'PATCH',
      query: { id: `eq.${id}` },
      body: dbPatch,
      prefer: 'return=representation',
    });
  }

  async nextChildIndex(merchantId: string): Promise<number> {
    // The production schema exposes a SECURITY DEFINER function that
    // atomically returns + bumps next_child_index. If it is absent (e.g. a
    // fresh Supabase project on a custom schema), fall back to a SELECT /
    // UPDATE pair — race-window present in that fallback is acceptable
    // because the SECURITY DEFINER path is the documented production setup.
    try {
      const idx = await this.rest<number | { result?: number }>(
        `rpc/zettapay_allocate_child_index`,
        { method: 'POST', body: { p_merchant: merchantId } },
      );
      if (typeof idx === 'number') return idx;
      if (idx && typeof idx === 'object' && typeof idx.result === 'number') {
        return idx.result;
      }
    } catch (err) {
      if (!(err instanceof StoragePersistenceError) || err.status !== 404) {
        throw err;
      }
    }
    const rows = await this.rest<Array<{ next_child_index: number | null }>>(
      this.merchantsTable,
      {
        query: { id: `eq.${merchantId}`, select: 'next_child_index', limit: '1' },
      },
    );
    const row = rows[0];
    if (!row) {
      throw new StoragePersistenceError(
        `supabase merchant "${merchantId}" not found`,
        404,
        '',
      );
    }
    const current = row.next_child_index ?? 0;
    await this.rest<MerchantRow[]>(this.merchantsTable, {
      method: 'PATCH',
      query: { id: `eq.${merchantId}` },
      body: { next_child_index: current + 1 },
      prefer: 'return=representation',
    });
    return current;
  }

  async close(): Promise<void> {
    /* no-op for HTTP transport */
  }

  // ---------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------

  private mapMerchant(row: MerchantRow): Merchant {
    return {
      id: row.id,
      shop_name: row.shop_name,
      email: row.email,
      xpub: row.xpub,
      webhook_url: row.webhook_url ?? '',
      webhook_secret_hash: row.webhook_secret ?? '',
      next_child_index: row.next_child_index ?? 0,
      created_at: row.created_at,
    };
  }

  private mapInvoice(row: InvoiceRow): Invoice {
    const chain = normalizeChain(row.chain);
    const status = normalizeStatus(row.status);
    const amount = row.amount_btc ?? '';
    const inv: Invoice = {
      id: row.id,
      merchant_id: row.merchant_id,
      chain,
      asset: assetForChain(chain),
      amount,
      address: row.receive_address,
      child_index: row.child_index ?? null,
      status,
      expires_at: row.expires_at,
      paid_at: row.confirmed_at ?? null,
      tx_hash: row.tx_hash ?? null,
      created_at: row.created_at,
      updated_at: row.updated_at ?? row.created_at,
      receive_address: row.receive_address,
      amount_btc: row.amount_btc ?? null,
      amount_usd:
        row.amount_usd === null || row.amount_usd === undefined
          ? null
          : Number(row.amount_usd),
      required_confirmations: row.required_confirmations ?? null,
      confirmations: row.confirmations ?? null,
      metadata: row.metadata ?? null,
      detected_at: row.detected_at ?? null,
      confirmed_at: row.confirmed_at ?? null,
    };
    return inv;
  }

  private mapWebhookEvent(row: WebhookRow): WebhookEvent {
    const payloadJson =
      row.payload_json ?? (row.payload ? JSON.stringify(row.payload) : '');
    return {
      id: row.id,
      invoice_id: row.invoice_id,
      payload_json: payloadJson,
      attempts: row.attempts ?? 0,
      next_retry_at: row.next_retry_at,
      delivered_at: row.delivered_at,
      last_status_code: row.last_status_code,
      last_error: row.last_error,
    };
  }
}
