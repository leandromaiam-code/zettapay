import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
  InvoiceNotFoundError,
  MerchantNotInitializedError,
  StorageCorruptionError,
  WebhookEventNotFoundError,
} from '../errors.js';
import type {
  Invoice,
  InvoiceInput,
  InvoiceStatus,
  ListPendingInvoicesOpts,
  Merchant,
  MerchantInput,
  WebhookDeliveryResult,
  WebhookEvent,
  WebhookEventInput,
} from '../types.js';
import type {
  BulkExport,
  BulkImportInput,
  BulkImportResult,
  BulkPortable,
  StorageAdapter,
} from './index.js';

export interface JsonFileStorageOptions {
  /** Defaults to ~/.zettapay/data */
  dataDir?: string;
}

const LOCK_RETRY_OPTS = {
  retries: { retries: 10, factor: 1.2, minTimeout: 20, maxTimeout: 100 },
  stale: 10_000,
} as const;

export class JsonFileStorage implements StorageAdapter, BulkPortable {
  private readonly dataDir: string;
  private readonly invoicesDir: string;
  private readonly webhookEventsDir: string;
  private readonly merchantPath: string;
  private initPromise: Promise<void> | null = null;
  /**
   * In-process serializer for `nextChildIndex`. Many parallel callers inside
   * one Node process would otherwise dog-pile `proper-lockfile`, which only
   * polls — chaining on a promise lets us coalesce those callers into a
   * single lock acquisition queue without ever touching setTimeout / setInterval.
   */
  private indexQueue: Promise<unknown> = Promise.resolve();

  constructor(opts: JsonFileStorageOptions = {}) {
    this.dataDir = opts.dataDir ?? path.join(os.homedir(), '.zettapay', 'data');
    this.invoicesDir = path.join(this.dataDir, 'invoices');
    this.webhookEventsDir = path.join(this.dataDir, 'webhook_events');
    this.merchantPath = path.join(this.dataDir, 'merchant.json');
  }

  async init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.doInit();
    }
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true });
    await fs.mkdir(this.invoicesDir, { recursive: true });
    await fs.mkdir(this.webhookEventsDir, { recursive: true });
    const sentinel = path.join(this.dataDir, '.lock');
    try {
      await fs.access(sentinel);
    } catch {
      await fs.writeFile(sentinel, '', { flag: 'wx' }).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'EEXIST') throw err;
      });
    }
  }

  async getMerchant(_id: string): Promise<Merchant | null> {
    await this.init();
    return this.readMerchantOrNull();
  }

  async createMerchant(input: MerchantInput): Promise<Merchant> {
    await this.init();
    const existing = await this.readMerchantOrNull();
    if (existing) return existing;
    const merchant: Merchant = {
      id: randomUUID(),
      shop_name: input.shop_name,
      email: input.email,
      xpub: input.xpub,
      webhook_url: input.webhook_url,
      webhook_secret_hash: input.webhook_secret_hash,
      next_child_index: 0,
      created_at: new Date().toISOString(),
    };
    await this.atomicWrite(this.merchantPath, merchant);
    return merchant;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    await this.init();
    const id = input.id || `inv_${randomUUID()}`;
    const now = new Date().toISOString();
    const invoice: Invoice = {
      id,
      merchant_id: input.merchant_id,
      chain: input.chain,
      asset: input.asset,
      amount: input.amount,
      address: input.address,
      child_index: input.child_index,
      status: input.status ?? 'pending',
      expires_at: input.expires_at,
      paid_at: null,
      tx_hash: null,
      created_at: now,
      updated_at: now,
    };
    await this.atomicWrite(this.invoicePath(id), invoice);
    return invoice;
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    await this.init();
    return this.readJsonOrNull<Invoice>(this.invoicePath(id));
  }

  async listPendingInvoices(opts: ListPendingInvoicesOpts = {}): Promise<Invoice[]> {
    await this.init();
    const entries = await fs.readdir(this.invoicesDir).catch(() => [] as string[]);
    const nowMs = Date.now();
    const out: Invoice[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(this.invoicesDir, entry);
      let inv: Invoice | null;
      try {
        inv = await this.readJsonOrNull<Invoice>(filePath);
      } catch (err) {
        console.warn(`[zettapay-listener] skipping corrupted invoice file: ${filePath}`, err);
        continue;
      }
      if (!inv) continue;
      if (inv.status !== 'pending') continue;
      if (Date.parse(inv.expires_at) <= nowMs) continue;
      if (opts.chain && inv.chain !== opts.chain) continue;
      out.push(inv);
      if (opts.limit && out.length >= opts.limit) break;
    }
    return out;
  }

  async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch: Partial<Invoice> = {},
  ): Promise<Invoice> {
    await this.init();
    const filePath = this.invoicePath(id);
    const current = await this.readJsonOrNull<Invoice>(filePath);
    if (!current) throw new InvoiceNotFoundError(id);
    const merged: Invoice = {
      ...current,
      ...patch,
      id: current.id,
      merchant_id: current.merchant_id,
      created_at: current.created_at,
      status,
      updated_at: new Date().toISOString(),
    };
    await this.atomicWrite(filePath, merged);
    return merged;
  }

  async recordWebhookEvent(input: WebhookEventInput): Promise<WebhookEvent> {
    await this.init();
    const event: WebhookEvent = {
      id: input.id,
      invoice_id: input.invoice_id,
      payload_json: input.payload_json,
      attempts: 0,
      next_retry_at: input.next_retry_at,
      delivered_at: null,
      last_status_code: null,
      last_error: null,
    };
    await this.atomicWrite(this.webhookEventPath(event.id), event);
    return event;
  }

  async getWebhookEventsDue(now: Date, limit: number): Promise<WebhookEvent[]> {
    await this.init();
    const entries = await fs.readdir(this.webhookEventsDir).catch(() => [] as string[]);
    const cutoff = now.getTime();
    const out: WebhookEvent[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(this.webhookEventsDir, entry);
      let evt: WebhookEvent | null;
      try {
        evt = await this.readJsonOrNull<WebhookEvent>(filePath);
      } catch (err) {
        console.warn(`[zettapay-listener] skipping corrupted webhook file: ${filePath}`, err);
        continue;
      }
      if (!evt) continue;
      if (evt.delivered_at) continue;
      if (Date.parse(evt.next_retry_at) > cutoff) continue;
      out.push(evt);
      if (limit && out.length >= limit) break;
    }
    return out;
  }

  async markWebhookDelivered(id: string, result: WebhookDeliveryResult): Promise<void> {
    await this.init();
    const filePath = this.webhookEventPath(id);
    const current = await this.readJsonOrNull<WebhookEvent>(filePath);
    if (!current) throw new WebhookEventNotFoundError(id);
    const updated: WebhookEvent = {
      ...current,
      attempts: current.attempts + 1,
      delivered_at: result.ok ? new Date().toISOString() : current.delivered_at,
      last_status_code: result.statusCode ?? current.last_status_code,
      last_error: result.ok ? null : (result.error ?? current.last_error),
      next_retry_at: result.ok
        ? current.next_retry_at
        : result.nextRetryAt
          ? result.nextRetryAt.toISOString()
          : current.next_retry_at,
    };
    await this.atomicWrite(filePath, updated);
  }

  async nextChildIndex(merchantId: string): Promise<number> {
    const run = async (): Promise<number> => {
      await this.init();
      const pre = await this.readMerchantOrNull();
      if (!pre) throw new MerchantNotInitializedError(this.dataDir);
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(this.merchantPath, LOCK_RETRY_OPTS);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === 'ENOENT') throw new MerchantNotInitializedError(this.dataDir);
        throw err;
      }
      try {
        const merchant = await this.readMerchantOrNull();
        if (!merchant) throw new MerchantNotInitializedError(this.dataDir);
        if (merchant.id !== merchantId) {
          throw new Error(
            `@zettapay/listener: nextChildIndex called for unknown merchant id "${merchantId}" (have "${merchant.id}").`,
          );
        }
        const preIncrement = merchant.next_child_index;
        const next: Merchant = { ...merchant, next_child_index: preIncrement + 1 };
        await this.atomicWrite(this.merchantPath, next);
        return preIncrement;
      } finally {
        await release();
      }
    };
    const result = this.indexQueue.then(run, run);
    this.indexQueue = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    this.initPromise = null;
  }

  async exportAll(): Promise<BulkExport> {
    await this.init();
    const merchant = await this.readMerchantOrNull();
    const invoices: Invoice[] = [];
    for (const entry of await fs.readdir(this.invoicesDir).catch(() => [] as string[])) {
      if (!entry.endsWith('.json')) continue;
      const inv = await this.readJsonOrNull<Invoice>(path.join(this.invoicesDir, entry));
      if (inv) invoices.push(inv);
    }
    const webhookEvents: WebhookEvent[] = [];
    for (const entry of await fs.readdir(this.webhookEventsDir).catch(() => [] as string[])) {
      if (!entry.endsWith('.json')) continue;
      const evt = await this.readJsonOrNull<WebhookEvent>(path.join(this.webhookEventsDir, entry));
      if (evt) webhookEvents.push(evt);
    }
    return { merchant, invoices, webhookEvents };
  }

  async importBulk(data: BulkImportInput): Promise<BulkImportResult> {
    await this.init();
    let merchants = 0;
    if (data.merchant) {
      await this.atomicWrite(this.merchantPath, data.merchant);
      merchants = 1;
    }
    let invoices = 0;
    for (const inv of data.invoices ?? []) {
      await this.atomicWrite(this.invoicePath(inv.id), inv);
      invoices += 1;
    }
    let webhookEvents = 0;
    for (const evt of data.webhookEvents ?? []) {
      await this.atomicWrite(this.webhookEventPath(evt.id), evt);
      webhookEvents += 1;
    }
    return { merchants, invoices, webhookEvents };
  }

  private invoicePath(id: string): string {
    return path.join(this.invoicesDir, `${id}.json`);
  }

  private webhookEventPath(id: string): string {
    return path.join(this.webhookEventsDir, `${id}.json`);
  }

  private async readMerchantOrNull(): Promise<Merchant | null> {
    return this.readJsonOrNull<Merchant>(this.merchantPath);
  }

  private async readJsonOrNull<T>(filePath: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return JSON.parse(raw) as T;
    } catch (err) {
      throw new StorageCorruptionError(filePath, err);
    }
  }

  private async atomicWrite(filePath: string, value: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    const tmp = path.join(
      dir,
      `.${path.basename(filePath)}.tmp.${process.pid}.${randomUUID()}`,
    );
    const serialized = JSON.stringify(value, null, 2);
    try {
      await fs.writeFile(tmp, serialized, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, filePath);
    } catch (err) {
      await fs.unlink(tmp).catch(() => undefined);
      throw err;
    }
  }
}
