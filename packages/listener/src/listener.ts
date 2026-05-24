// BtcListener — long-running worker that watches the merchant's BIP-84
// receive addresses on mempool.space and walks each pending invoice through
// the confirmations curve to `confirmed`. Persistence + webhook bookkeeping
// flow exclusively through StorageAdapter (HR-STORAGE-ADAPTER).
//
// Network surface (HR-PHONE-HOME):
//   - wss://mempool.space/api/v1/ws    (subscribe + tx + block events)
//   - https://mempool.space/api/...    (REST backfill on boot)
// Nothing else. No zettapay.* host is reachable from this file.

import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { StorageAdapter } from './storage/index.js';
import type { Invoice } from './types.js';

const DEFAULT_WS_URL = 'wss://mempool.space/api/v1/ws';
const DEFAULT_REST_BASE = 'https://mempool.space/api';
const RECONNECT_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000] as const;
const RECONCILE_INTERVAL_MS = 30_000;
const BACKFILL_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_INITIAL_MS = 1_000;

export interface BtcListenerOptions {
  storage: StorageAdapter;
  merchantId: string;
  wsUrl?: string;
  restBase?: string;
  reconcileIntervalMs?: number;
  /** Override required confirmations resolver. Defaults to tiered policy by BTC amount. */
  requiredConfirmations?: (invoice: Invoice) => number;
  logger?: Logger;
}

export interface Logger {
  info: (msg: string, meta?: unknown) => void;
  warn: (msg: string, meta?: unknown) => void;
  error: (msg: string, meta?: unknown) => void;
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface ListenerStatus {
  wsConnected: boolean;
  subscribedCount: number;
  lastEventAt: number | null;
  lastBlockHeight: number | null;
  uptimeSeconds: number;
}

interface MempoolTx {
  txid: string;
  status?: { confirmed?: boolean; block_height?: number };
  vout?: Array<{ scriptpubkey_address?: string; value?: number }>;
}

interface MempoolWsMessage {
  block?: { height: number };
  blocks?: Array<{ height: number }>;
  'multi-address-transactions'?: Record<
    string,
    { confirmed?: MempoolTx[]; mempool?: MempoolTx[]; removed?: MempoolTx[] }
  >;
  'address-transactions'?: Record<string, MempoolTx[]>;
}

export class BtcListener {
  private readonly storage: StorageAdapter;
  private readonly merchantId: string;
  private readonly wsUrl: string;
  private readonly restBase: string;
  private readonly reconcileIntervalMs: number;
  private readonly resolveRequired: (invoice: Invoice) => number;
  private readonly log: Logger;

  private ws: WebSocket | null = null;
  private subscribed = new Set<string>();
  private addressToInvoiceId = new Map<string, string>();
  private reconnectAttempt = 0;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly startedAt = Date.now();
  private lastEventAt: number | null = null;
  private lastBlockHeight: number | null = null;

  constructor(opts: BtcListenerOptions) {
    this.storage = opts.storage;
    this.merchantId = opts.merchantId;
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL;
    this.restBase = (opts.restBase ?? DEFAULT_REST_BASE).replace(/\/$/, '');
    this.reconcileIntervalMs = opts.reconcileIntervalMs ?? RECONCILE_INTERVAL_MS;
    this.resolveRequired = opts.requiredConfirmations ?? defaultRequiredConfirmations;
    this.log = opts.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.backfillPending();
    this.connect();
    this.scheduleReconcile();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconcileTimer) {
      clearTimeout(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore close errors
      }
      this.ws = null;
    }
  }

  status(): ListenerStatus {
    return {
      wsConnected: this.ws?.readyState === WebSocket.OPEN,
      subscribedCount: this.subscribed.size,
      lastEventAt: this.lastEventAt,
      lastBlockHeight: this.lastBlockHeight,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  // --- connection lifecycle -------------------------------------------------

  private connect(): void {
    if (this.stopped) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectAttempt = 0;
      this.log.info('btc_listener.ws_open', { url: this.wsUrl });
      ws.send(JSON.stringify({ action: 'want', data: ['blocks'] }));
      void this.reconcileSubscriptions();
    });

    ws.on('message', (data) => {
      this.lastEventAt = Date.now();
      let msg: MempoolWsMessage;
      try {
        msg = JSON.parse(data.toString()) as MempoolWsMessage;
      } catch {
        return;
      }
      if (msg.block?.height) this.lastBlockHeight = msg.block.height;
      if (Array.isArray(msg.blocks)) {
        const heights = msg.blocks.map((b) => b.height).filter((h): h is number => typeof h === 'number');
        if (heights.length > 0) this.lastBlockHeight = Math.max(...heights);
      }
      this.handleWsMessage(msg).catch((err) => this.log.error('btc_listener.handle_failed', err));
    });

    ws.on('error', (err) => {
      this.log.warn('btc_listener.ws_error', err);
    });

    ws.on('close', () => {
      this.ws = null;
      if (this.stopped) return;
      const delay =
        RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)] ??
        RECONNECT_BACKOFF_MS[RECONNECT_BACKOFF_MS.length - 1]!;
      this.reconnectAttempt += 1;
      this.log.warn('btc_listener.ws_closed', { reconnect_in_ms: delay, attempt: this.reconnectAttempt });
      setTimeout(() => {
        if (!this.stopped) this.connect();
      }, delay);
    });
  }

  // --- subscription reconciliation -----------------------------------------

  private scheduleReconcile(): void {
    if (this.stopped) return;
    this.reconcileTimer = setTimeout(() => {
      this.reconcileSubscriptions()
        .catch((err) => this.log.error('btc_listener.reconcile_failed', err))
        .finally(() => this.scheduleReconcile());
    }, this.reconcileIntervalMs);
  }

  private async reconcileSubscriptions(): Promise<void> {
    const pending = await this.storage.listPendingInvoices({ chain: 'btc' });
    const targets = new Set<string>();
    this.addressToInvoiceId.clear();
    for (const inv of pending) {
      targets.add(inv.address);
      this.addressToInvoiceId.set(inv.address, inv.id);
    }
    // Diff
    let changed = false;
    for (const addr of targets) {
      if (!this.subscribed.has(addr)) {
        this.subscribed.add(addr);
        changed = true;
      }
    }
    for (const addr of Array.from(this.subscribed)) {
      if (!targets.has(addr)) {
        this.subscribed.delete(addr);
        changed = true;
      }
    }
    if (changed) this.sendTrackAddresses();
  }

  private sendTrackAddresses(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        action: 'track-addresses',
        data: Array.from(this.subscribed),
      }),
    );
  }

  // --- event processing -----------------------------------------------------

  private async handleWsMessage(msg: MempoolWsMessage): Promise<void> {
    const buckets = msg['multi-address-transactions'];
    if (buckets) {
      for (const [addr, group] of Object.entries(buckets)) {
        const txs = [...(group.confirmed ?? []), ...(group.mempool ?? [])];
        for (const tx of txs) await this.processTx(addr, tx);
      }
    }
    const flat = msg['address-transactions'];
    if (flat) {
      for (const [addr, txs] of Object.entries(flat)) {
        for (const tx of txs) await this.processTx(addr, tx);
      }
    }
    if (msg.block || Array.isArray(msg.blocks)) {
      // New block can advance confirmations on already-recorded txs.
      await this.advanceConfirmationsOnNewBlock();
    }
  }

  private async processTx(address: string, tx: MempoolTx): Promise<void> {
    const invoiceId = this.addressToInvoiceId.get(address);
    if (!invoiceId) return;
    const invoice = await this.storage.getInvoice(invoiceId);
    if (!invoice || invoice.status !== 'pending') return;

    const confirmations = this.computeConfirmations(tx);
    const required = this.resolveRequired(invoice);
    const txHash = tx.txid;

    if (confirmations >= required) {
      const confirmed = await this.storage.updateInvoiceStatus(invoice.id, 'confirmed', {
        tx_hash: txHash,
        paid_at: new Date().toISOString(),
      });
      await this.emitConfirmedWebhook(confirmed, confirmations);
      this.subscribed.delete(address);
      this.addressToInvoiceId.delete(address);
      this.sendTrackAddresses();
    } else {
      // Mark we have a candidate tx hash but stay pending — backfill on next
      // block tick (or REST poll) will eventually flip to confirmed.
      if (invoice.tx_hash !== txHash) {
        await this.storage.updateInvoiceStatus(invoice.id, 'pending', { tx_hash: txHash });
      }
    }
  }

  private computeConfirmations(tx: MempoolTx): number {
    if (!tx.status?.confirmed) return 0;
    const txBlock = tx.status.block_height;
    if (typeof txBlock !== 'number' || this.lastBlockHeight === null) return 1;
    return Math.max(1, this.lastBlockHeight - txBlock + 1);
  }

  private async advanceConfirmationsOnNewBlock(): Promise<void> {
    // For each pending invoice with a candidate tx, REST-fetch and recompute.
    const pending = await this.storage.listPendingInvoices({ chain: 'btc' });
    for (const inv of pending) {
      if (!inv.tx_hash) continue;
      const tx = await this.fetchTx(inv.tx_hash);
      if (!tx) continue;
      await this.processTx(inv.address, tx);
    }
  }

  // --- REST helpers ---------------------------------------------------------

  private async fetchTx(txid: string): Promise<MempoolTx | null> {
    return await this.restGet<MempoolTx>(`/tx/${encodeURIComponent(txid)}`);
  }

  private async fetchAddressTxs(address: string): Promise<MempoolTx[]> {
    return (await this.restGet<MempoolTx[]>(`/address/${encodeURIComponent(address)}/txs`)) ?? [];
  }

  private async restGet<T>(path: string): Promise<T | null> {
    const url = `${this.restBase}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), BACKFILL_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch (err) {
      this.log.warn('btc_listener.rest_failed', { url, err: (err as Error).message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // --- backfill -------------------------------------------------------------

  private async backfillPending(): Promise<void> {
    const pending = await this.storage.listPendingInvoices({ chain: 'btc' });
    for (const inv of pending) {
      const txs = await this.fetchAddressTxs(inv.address);
      for (const tx of txs) {
        await this.processTx(inv.address, tx);
      }
    }
  }

  // --- webhook hand-off -----------------------------------------------------

  private async emitConfirmedWebhook(invoice: Invoice, confirmations: number): Promise<void> {
    const payload = {
      event: 'invoice.confirmed',
      invoice_id: invoice.id,
      merchant_id: invoice.merchant_id,
      chain: invoice.chain,
      asset: invoice.asset,
      amount: invoice.amount,
      address: invoice.address,
      tx_hash: invoice.tx_hash,
      confirmations,
      confirmed_at: invoice.paid_at ?? new Date().toISOString(),
    };
    await this.storage.recordWebhookEvent({
      id: `evt_${randomUUID()}`,
      invoice_id: invoice.id,
      payload_json: JSON.stringify(payload),
      next_retry_at: new Date(Date.now() + WEBHOOK_RETRY_INITIAL_MS).toISOString(),
    });
  }
}

function defaultRequiredConfirmations(invoice: Invoice): number {
  if (invoice.chain !== 'btc') return 1;
  const btc = Number(invoice.amount);
  if (!Number.isFinite(btc)) return 6;
  if (btc < 0.001) return 1;
  if (btc < 0.01) return 3;
  return 6;
}
