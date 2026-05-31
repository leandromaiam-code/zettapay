// BaseWatcher — long-running worker that watches USDC (an ERC-20 with 6
// decimals) on the Base L2 for each pending invoice with chain='base'. It
// mirrors the BtcListener's role but uses a simple poll loop: for every pending
// base invoice it calls `balanceOf(address)` on the USDC contract via a single
// public JSON-RPC endpoint and flips the invoice to `confirmed` once the
// on-chain balance covers the required amount. Persistence + webhook bookkeeping
// flow exclusively through StorageAdapter (HR-STORAGE-ADAPTER), and confirmed
// invoices hand off to the SAME webhook pipeline the BTC path uses.
//
// This file is 100% additive: it never imports or mutates BtcListener state.
//
// Network surface (HR-PHONE-HOME):
//   - BASE_RPC_URL (default https://mainnet.base.org) — a public Base RPC.
// Nothing else. No zettapay.* host is reachable from this file. We use
// `eth_call balanceOf(address)` per address rather than scanning logs, so the
// cost is one cheap read per pending invoice per poll.

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { Invoice } from './types.js';
import type { Logger } from './listener.js';

export const DEFAULT_BASE_RPC_URL = 'https://mainnet.base.org';
/** Canonical USDC token on Base mainnet (6 decimals). */
export const USDC_BASE_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
/** ERC-20 balanceOf(address) selector = keccak256("balanceOf(address)")[0:4]. */
const BALANCE_OF_SELECTOR = '0x70a08231';
const DEFAULT_POLL_INTERVAL_MS = 8_000;
const RPC_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_INITIAL_MS = 1_000;

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface BaseWatcherOptions {
  storage: StorageAdapter;
  merchantId: string;
  rpcUrl?: string;
  usdcAddress?: string;
  pollIntervalMs?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface BaseWatcherStatus {
  running: boolean;
  rpcUrl: string;
  usdcAddress: string;
  lastPollAt: number | null;
  lastPollOk: boolean;
  pendingCount: number;
  uptimeSeconds: number;
}

function isHexAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function encodeBalanceOf(address: string): string {
  // 32-byte big-endian, left-padded address argument.
  const hex = address.slice(2).toLowerCase().padStart(64, '0');
  return `${BALANCE_OF_SELECTOR}${hex}`;
}

export class BaseWatcher {
  private readonly storage: StorageAdapter;
  private readonly merchantId: string;
  private readonly rpcUrl: string;
  private readonly usdcAddress: string;
  private readonly pollIntervalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private rpcId = 0;
  private readonly startedAt = Date.now();
  private lastPollAt: number | null = null;
  private lastPollOk = false;
  private pendingCount = 0;

  constructor(opts: BaseWatcherOptions) {
    this.storage = opts.storage;
    this.merchantId = opts.merchantId;
    this.rpcUrl = (opts.rpcUrl ?? DEFAULT_BASE_RPC_URL).replace(/\/$/, '');
    this.usdcAddress = opts.usdcAddress ?? USDC_BASE_ADDRESS;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? noopLogger;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.pollOnce();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): BaseWatcherStatus {
    return {
      running: !this.stopped,
      rpcUrl: this.rpcUrl,
      usdcAddress: this.usdcAddress,
      lastPollAt: this.lastPollAt,
      lastPollOk: this.lastPollOk,
      pendingCount: this.pendingCount,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.pollOnce()
        .catch((err) => this.log.error('base_watcher.poll_failed', err))
        .finally(() => this.schedule());
    }, this.pollIntervalMs);
  }

  /**
   * One reconciliation pass. Any RPC failure is logged and swallowed so the
   * loop never crashes — the same invoice is retried on the next tick.
   */
  async pollOnce(): Promise<void> {
    this.lastPollAt = Date.now();
    let allOk = true;
    let pending: Invoice[];
    try {
      pending = await this.storage.listPendingInvoices({ chain: 'base' });
    } catch (err) {
      this.lastPollOk = false;
      this.log.warn('base_watcher.list_failed', { err: (err as Error).message });
      return;
    }
    this.pendingCount = pending.length;
    for (const inv of pending) {
      try {
        const ok = await this.checkInvoice(inv);
        if (!ok) allOk = false;
      } catch (err) {
        allOk = false;
        this.log.warn('base_watcher.invoice_failed', {
          invoice_id: inv.id,
          err: (err as Error).message,
        });
      }
    }
    this.lastPollOk = allOk;
  }

  /** Returns false when the RPC read failed (so the poll is marked degraded). */
  private async checkInvoice(invoice: Invoice): Promise<boolean> {
    if (!isHexAddress(invoice.address)) {
      this.log.warn('base_watcher.bad_address', { invoice_id: invoice.id, address: invoice.address });
      return true;
    }
    const balance = await this.balanceOf(invoice.address);
    if (balance === null) return false;

    const required = this.requiredUnits(invoice);
    if (balance >= required) {
      const confirmed = await this.storage.updateInvoiceStatus(invoice.id, 'confirmed', {
        paid_at: new Date().toISOString(),
      });
      await this.emitConfirmedWebhook(confirmed, balance);
      this.log.info('base_watcher.invoice_confirmed', {
        invoice_id: invoice.id,
        address: invoice.address,
        balance: balance.toString(),
      });
    }
    return true;
  }

  private requiredUnits(invoice: Invoice): bigint {
    try {
      return BigInt(invoice.amount);
    } catch {
      throw new Error(`base invoice amount must be integer USDC base units, got "${invoice.amount}"`);
    }
  }

  /** eth_call USDC.balanceOf(address) → bigint base units, or null on failure. */
  private async balanceOf(address: string): Promise<bigint | null> {
    const body = {
      jsonrpc: '2.0',
      id: (this.rpcId += 1),
      method: 'eth_call',
      params: [{ to: this.usdcAddress, data: encodeBalanceOf(address) }, 'latest'],
    };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log.warn('base_watcher.rpc_http_error', { status: res.status });
        return null;
      }
      const json = (await res.json()) as { result?: string; error?: { message?: string } };
      if (json.error) {
        this.log.warn('base_watcher.rpc_error', { err: json.error.message });
        return null;
      }
      if (typeof json.result !== 'string' || !json.result.startsWith('0x')) {
        return null;
      }
      // Empty result (0x) means the call returned no data — treat as zero.
      return json.result === '0x' ? 0n : BigInt(json.result);
    } catch (err) {
      this.log.warn('base_watcher.rpc_failed', { rpc: this.rpcUrl, err: (err as Error).message });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async emitConfirmedWebhook(invoice: Invoice, balanceUnits: bigint): Promise<void> {
    const payload = {
      event: 'invoice.confirmed',
      invoice_id: invoice.id,
      merchant_id: invoice.merchant_id,
      chain: invoice.chain,
      asset: invoice.asset,
      amount: invoice.amount,
      address: invoice.address,
      tx_hash: invoice.tx_hash,
      balance: balanceUnits.toString(),
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
