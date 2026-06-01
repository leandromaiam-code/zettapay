// SupabaseStorageAdapter — the multi-tenant StorageAdapter the cloud service
// hands to the SAME @zettapay/listener core (invoice-core, watchers, dispatcher)
// that a self-hosted merchant runs against JSON/SQLite. Nothing about the core
// changes: it just persists through Supabase instead of the local filesystem.
//
// Multi-tenancy: `getMerchant(id)` / `nextChildIndex(id)` are scoped to one
// merchant, while `listPendingInvoices()` deliberately spans EVERY tenant so a
// single watcher fleet can reconcile all merchants at once.
//
// NON-CUSTODIAL: addresses come from the merchant's public xpub or a public
// fixed receive address. No private key is read, derived, or stored.

import { randomUUID } from 'node:crypto';
import {
  InvoiceNotFoundError,
  WebhookEventNotFoundError,
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
} from '@zettapay/listener';
import type { StorageAdapter } from '@zettapay/listener/storage';
import type {
  CloudChain,
  CloudDb,
  InvoiceRow,
  MerchantChainRow,
  WebhookEventRow,
} from './cloud-db.js';

// A single shared counter can be contended by every concurrent invoice
// creation for one merchant; an unlucky caller may lose the CAS up to (N-1)
// times before winning, so the retry budget must exceed realistic burst depth.
const MAX_CAS_ATTEMPTS = 512;

export interface ChainConfig {
  chain: CloudChain;
  xpub: string | null;
  fixedAddress: string | null;
  evmTokens: string[];
}

export class SupabaseStorageAdapter implements StorageAdapter {
  constructor(private readonly db: CloudDb) {}

  async getMerchant(id: string): Promise<Merchant | null> {
    const row = await this.db.getMerchant(id);
    if (!row) return null;
    const chains = await this.db.getChains(id);
    const primary = chains.find((c) => c.chain === 'btc') ?? chains[0];
    const webhook = await this.db.getWebhook(id);
    return {
      id: row.id,
      shop_name: row.name,
      email: row.email,
      xpub: primary?.xpub ?? '',
      webhook_url: webhook?.url ?? '',
      webhook_secret_hash: webhook?.secret_enc ?? '',
      next_child_index: primary?.next_child_index ?? 0,
      created_at: row.created_at,
    };
  }

  async createMerchant(input: MerchantInput): Promise<Merchant> {
    const id = randomUUID();
    const now = new Date().toISOString();
    await this.db.insertMerchant({
      id,
      auth_uid: null,
      email: input.email,
      name: input.shop_name,
      created_at: now,
    });
    await this.db.insertChain({
      id: randomUUID(),
      merchant_id: id,
      chain: 'btc',
      xpub: input.xpub || null,
      fixed_address: null,
      evm_tokens: null,
      next_child_index: 0,
      created_at: now,
    });
    if (input.webhook_url) {
      await this.db.insertWebhook({
        id: randomUUID(),
        merchant_id: id,
        url: input.webhook_url,
        secret_enc: input.webhook_secret_hash,
        created_at: now,
      });
    }
    const merchant = await this.getMerchant(id);
    if (!merchant) throw new Error('@zettapay/cloud: merchant vanished immediately after insert');
    return merchant;
  }

  async nextChildIndex(merchantId: string): Promise<number> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const primary = await this.primaryChain(merchantId);
      if (!primary) {
        throw new Error(`@zettapay/cloud: merchant "${merchantId}" has no chain to derive from`);
      }
      const current = primary.next_child_index;
      const won = await this.db.casChildIndex(primary.id, current, current + 1);
      if (won) return current;
    }
    throw new Error(
      `@zettapay/cloud: nextChildIndex gave up after ${MAX_CAS_ATTEMPTS} contended attempts`,
    );
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const now = new Date().toISOString();
    const row: InvoiceRow = {
      id: input.id,
      merchant_id: input.merchant_id,
      chain: input.chain,
      asset: input.asset,
      amount_sats: null,
      amount_units: input.amount,
      amount_usd: null,
      address: input.address,
      child_index: input.child_index,
      nonce: null,
      status: input.status ?? 'pending',
      tx_hash: null,
      expires_at: input.expires_at,
      created_at: now,
      paid_at: null,
    };
    await this.db.insertInvoice(row);
    return rowToInvoice(row);
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    const row = await this.db.getInvoice(id);
    return row ? rowToInvoice(row) : null;
  }

  async listPendingInvoices(opts: ListPendingInvoicesOpts = {}): Promise<Invoice[]> {
    const rows = await this.db.listPendingInvoices({
      chain: opts.chain,
      limit: opts.limit,
      nowIso: new Date().toISOString(),
    });
    return rows.map(rowToInvoice);
  }

  async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch: Partial<Invoice> = {},
  ): Promise<Invoice> {
    const rowPatch: Partial<InvoiceRow> = { status };
    if (patch.paid_at !== undefined) rowPatch.paid_at = patch.paid_at;
    if (patch.tx_hash !== undefined) rowPatch.tx_hash = patch.tx_hash;
    if (patch.address !== undefined) rowPatch.address = patch.address;
    if (patch.amount !== undefined) rowPatch.amount_units = patch.amount;
    const updated = await this.db.updateInvoice(id, rowPatch);
    if (!updated) throw new InvoiceNotFoundError(id);
    return rowToInvoice(updated);
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<WebhookEvent> {
    const invoice = await this.db.getInvoice(input.invoice_id);
    let payload: unknown = {};
    let eventType = 'unknown';
    try {
      payload = JSON.parse(input.payload_json);
      if (payload && typeof payload === 'object' && 'event' in payload) {
        eventType = String((payload as Record<string, unknown>).event);
      }
    } catch {
      /* keep defaults — payload stored as parsed-or-empty */
    }
    const row: WebhookEventRow = {
      id: input.id,
      invoice_id: input.invoice_id,
      merchant_id: invoice?.merchant_id ?? '',
      event_type: eventType,
      payload,
      hmac: null,
      attempts: 0,
      next_attempt_at: input.next_retry_at,
      delivered_at: null,
      created_at: new Date().toISOString(),
    };
    await this.db.insertWebhookEvent(row);
    return rowToEvent(row);
  }

  async getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    const rows = await this.db.getDueWebhookEvents(now.toISOString(), limit);
    return rows.map(rowToEvent);
  }

  async markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void> {
    const current = await this.db.getWebhookEvent(id);
    if (!current) throw new WebhookEventNotFoundError(id);
    const patch: Partial<WebhookEventRow> = { attempts: current.attempts + 1 };
    if (result.ok) {
      patch.delivered_at = new Date().toISOString();
    } else if (result.nextRetryAt) {
      patch.next_attempt_at = result.nextRetryAt.toISOString();
    }
    await this.db.updateWebhookEvent(id, patch);
  }

  // --- cloud-only helpers (not part of StorageAdapter) -------------------

  /** Per-chain config used by the API server to pick xpub vs fixed-address mode. */
  async getChainConfig(merchantId: string, chain: CloudChain): Promise<ChainConfig | null> {
    const row = await this.db.getChain(merchantId, chain);
    if (!row) return null;
    return {
      chain: row.chain,
      xpub: row.xpub,
      fixedAddress: row.fixed_address,
      evmTokens: row.evm_tokens ?? [],
    };
  }

  /** Resolve a merchant's webhook endpoint + HMAC secret (for the dispatcher). */
  async getWebhookFor(merchantId: string): Promise<{ url: string; secret: string } | null> {
    const row = await this.db.getWebhook(merchantId);
    return row ? { url: row.url, secret: row.secret_enc } : null;
  }

  private async primaryChain(merchantId: string): Promise<MerchantChainRow | null> {
    const chains = await this.db.getChains(merchantId);
    return chains.find((c) => c.chain === 'btc') ?? chains[0] ?? null;
  }
}

function rowToInvoice(row: InvoiceRow): Invoice {
  return {
    id: row.id,
    merchant_id: row.merchant_id,
    chain: row.chain as Chain,
    asset: row.asset,
    amount: row.amount_units ?? '',
    address: row.address,
    child_index: row.child_index,
    status: row.status as InvoiceStatus,
    expires_at: row.expires_at,
    paid_at: row.paid_at,
    tx_hash: row.tx_hash,
    created_at: row.created_at,
    updated_at: row.paid_at ?? row.created_at,
  };
}

function rowToEvent(row: WebhookEventRow): WebhookEvent {
  return {
    id: row.id,
    invoice_id: row.invoice_id,
    payload_json: JSON.stringify(row.payload),
    attempts: row.attempts,
    next_retry_at: row.next_attempt_at,
    delivered_at: row.delivered_at,
    last_status_code: null,
    last_error: null,
  };
}
