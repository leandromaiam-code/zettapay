// Multi-tenant webhook dispatcher + watcher fleet.
//
// The watchers (BtcListener, BaseWatcher) are the UNMODIFIED listener core: they
// only ever call `storage.listPendingInvoices()` and read each invoice's stored
// address, so a single instance over the multi-tenant SupabaseStorageAdapter
// reconciles EVERY tenant at once. On confirmation they record a webhook event
// (tagged with the invoice's merchant_id) through the same StorageAdapter.
//
// The core's WebhookDispatcher signs with ONE secret for ONE URL, which cannot
// serve many tenants — so we re-implement the delivery loop here, routing each
// event to its merchant's own URL + HMAC secret. The retry curve and signature
// scheme are taken verbatim from the core (nextRetryDate, MAX_ATTEMPTS, HMAC-
// SHA256 over the raw body), so cloud and self-hosted deliveries are identical
// on the wire.

import { createHmac } from 'node:crypto';
import {
  BaseWatcher,
  BtcListener,
  MAX_ATTEMPTS,
  nextRetryDate,
  type Logger,
} from '@zettapay/listener';
import { SupabaseStorageAdapter } from './storage.js';

const FLEET_MERCHANT = '*cloud-fleet*';
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_BATCH = 50;
const DEFAULT_TIMEOUT_MS = 10_000;
const SIG_HEADER = 'X-ZettaPay-Signature';
const TS_HEADER = 'X-ZettaPay-Timestamp';
const EVENT_HEADER = 'X-ZettaPay-Event-Id';
const ATTEMPT_HEADER = 'X-ZettaPay-Attempt';

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface CloudWebhookDispatcherOptions {
  storage: SupabaseStorageAdapter;
  pollIntervalMs?: number;
  batchSize?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class CloudWebhookDispatcher {
  private readonly storage: SupabaseStorageAdapter;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private running = false;

  constructor(opts: CloudWebhookDispatcherOptions) {
    this.storage = opts.storage;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.batchSize = opts.batchSize ?? DEFAULT_BATCH;
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? noopLogger;
  }

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((err) => this.log.error('cloud_dispatcher.tick_failed', err))
        .finally(() => this.schedule());
    }, this.pollIntervalMs);
  }

  async tick(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    try {
      const due = await this.storage.getWebhookEventsDue(new Date(), this.batchSize);
      for (const evt of due) {
        if (this.stopped) break;
        await this.deliverOne(evt.id);
      }
    } finally {
      this.running = false;
    }
  }

  /** Deliver one event to its OWNING merchant's webhook endpoint. */
  async deliverOne(eventId: string): Promise<void> {
    const due = await this.storage.getWebhookEventsDue(new Date(0), this.batchSize + 1);
    const evt = due.find((e) => e.id === eventId) ?? null;
    if (!evt) return;
    if (evt.attempts >= MAX_ATTEMPTS) return;

    const invoice = await this.storage.getInvoice(evt.invoice_id);
    const webhook = invoice ? await this.storage.getWebhookFor(invoice.merchant_id) : null;
    if (!webhook || !webhook.url) {
      // Nowhere to deliver — retire the event so it stops polling.
      await this.storage.markWebhookDelivered(evt.id, { ok: true });
      return;
    }

    const attemptNumber = evt.attempts + 1;
    const body = evt.payload_json;
    const signature = createHmac('sha256', webhook.secret).update(body).digest('hex');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      [SIG_HEADER]: signature,
      [TS_HEADER]: String(Date.now()),
      [EVENT_HEADER]: evt.id,
      [ATTEMPT_HEADER]: String(attemptNumber),
    };

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    let statusCode: number | undefined;
    let error: string | undefined;
    let ok = false;
    try {
      const res = await this.fetchImpl(webhook.url, { method: 'POST', headers, body, signal: ctrl.signal });
      statusCode = res.status;
      ok = res.ok;
      if (!ok) error = `http_${statusCode}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timer);
    }

    await this.storage.markWebhookDelivered(evt.id, {
      ok,
      statusCode,
      error,
      nextRetryAt: ok ? null : nextRetryDate(attemptNumber),
    });
  }
}

export interface CloudFleet {
  listener: BtcListener;
  baseWatcher: BaseWatcher;
  dispatcher: CloudWebhookDispatcher;
  stop(): Promise<void>;
}

export interface CloudFleetOptions {
  storage: SupabaseStorageAdapter;
  btcWsUrl?: string;
  btcRestBase?: string;
  baseRpcUrl?: string;
  logger?: Logger;
}

/**
 * Start the multi-tenant reconciliation fleet: one BTC listener, one Base
 * watcher, and the per-tenant webhook dispatcher — all over the SAME shared
 * StorageAdapter. Returns handles plus a single `stop()`.
 */
export async function startCloudFleet(opts: CloudFleetOptions): Promise<CloudFleet> {
  const logger = opts.logger ?? noopLogger;
  const listener = new BtcListener({
    storage: opts.storage,
    merchantId: FLEET_MERCHANT,
    wsUrl: opts.btcWsUrl,
    restBase: opts.btcRestBase,
    logger,
  });
  const baseWatcher = new BaseWatcher({
    storage: opts.storage,
    merchantId: FLEET_MERCHANT,
    rpcUrl: opts.baseRpcUrl,
    logger,
  });
  const dispatcher = new CloudWebhookDispatcher({ storage: opts.storage, logger });

  dispatcher.start();
  await listener.start();
  await baseWatcher.start();

  return {
    listener,
    baseWatcher,
    dispatcher,
    async stop() {
      await listener.stop();
      await baseWatcher.stop();
      await dispatcher.stop();
    },
  };
}
