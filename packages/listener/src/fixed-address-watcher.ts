// FixedAddressWatcher — the second USDC receive mode (Z74). Where BaseWatcher
// (the xpub mode) derives one address per invoice and confirms by reading
// `balanceOf(address)`, this watcher serves merchants whose wallet cannot
// export an xpub: every invoice shares ONE fixed receive address and the payer
// is identified by the EXACT amount (a per-invoice nonce in the low USDC
// decimals — see evm-amount-nonce.ts).
//
// Because all invoices land on the same address, `balanceOf` alone is useless —
// it cannot attribute an individual payment. Instead we scan the ERC-20
// `Transfer` event log via `eth_getLogs` over a short trailing block window,
// capturing the EXACT value of each inbound transfer, then match that value to
// a pending invoice by nonce.
//
// This file is 100% additive and never imports or mutates BaseWatcher /
// BtcListener state. It edits no prohibited file.
//
// Network surface (HR-PHONE-HOME): only the configured public JSON-RPC endpoint
// per chain (BASE_RPC_URL / ETHEREUM_RPC_URL / POLYGON_RPC_URL). No zettapay.*
// host is reachable. HR-CUSTODY: only a public 0x receive address is used.

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { Chain, Invoice } from './types.js';
import type { Logger } from './listener.js';
import { matchAmount, NONCE_MODULUS } from './evm-amount-nonce.js';

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const DEFAULT_POLL_INTERVAL_MS = 8_000;
const RPC_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_INITIAL_MS = 1_000;
/** Trailing block window scanned each poll. Generous enough to absorb a missed
 *  tick yet bounded so public RPCs don't reject the range. */
const DEFAULT_BLOCK_WINDOW = 200;

export interface EvmChainSpec {
  /** Canonical Chain id stored on the invoice + reported in webhooks. */
  chain: Chain;
  /** EIP-155 chain id (used in the EIP-681 payment URI). */
  chainId: number;
  /** Canonical native-USDC token contract (6 decimals). */
  usdcAddress: string;
  /** Public JSON-RPC default; overridable per chain via env. */
  defaultRpcUrl: string;
  /** Env var that overrides defaultRpcUrl. */
  rpcEnvVar: string;
  /** Min confirmations before an inbound transfer is accepted. */
  minConfirmations: number;
}

/**
 * Registry of EVM chains the fixed-address mode understands, keyed by the value
 * a merchant puts in MERCHANT_EVM_CHAINS (csv). Native USDC contracts only.
 */
export const EVM_CHAIN_REGISTRY: Record<string, EvmChainSpec> = {
  base: {
    chain: 'base',
    chainId: 8453,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    defaultRpcUrl: 'https://mainnet.base.org',
    rpcEnvVar: 'BASE_RPC_URL',
    minConfirmations: 1,
  },
  ethereum: {
    chain: 'eth',
    chainId: 1,
    usdcAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    defaultRpcUrl: 'https://eth.llamarpc.com',
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    minConfirmations: 2,
  },
  polygon: {
    chain: 'polygon',
    chainId: 137,
    usdcAddress: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
    defaultRpcUrl: 'https://polygon-rpc.com',
    rpcEnvVar: 'POLYGON_RPC_URL',
    minConfirmations: 5,
  },
};

/** Resolve a registry spec from a chain alias (case-insensitive). */
export function lookupEvmChain(alias: string): EvmChainSpec | null {
  return EVM_CHAIN_REGISTRY[alias.trim().toLowerCase()] ?? null;
}

/**
 * Parse MERCHANT_EVM_CHAINS ("base,ethereum,polygon") into registry specs,
 * defaulting to ['base']. Unknown aliases are dropped with no throw so a typo
 * never crashes boot; the caller logs the effective set.
 */
export function parseFixedChains(csv: string | undefined): EvmChainSpec[] {
  const raw = (csv ?? 'base')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set<string>();
  const out: EvmChainSpec[] = [];
  for (const alias of raw.length ? raw : ['base']) {
    const spec = EVM_CHAIN_REGISTRY[alias];
    if (spec && !seen.has(alias)) {
      seen.add(alias);
      out.push(spec);
    }
  }
  return out.length ? out : [EVM_CHAIN_REGISTRY.base!];
}

const noopLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export interface FixedChainConfig extends EvmChainSpec {
  /** Effective RPC URL after env override. */
  rpcUrl: string;
}

export interface FixedAddressWatcherOptions {
  storage: StorageAdapter;
  merchantId: string;
  /** The single fixed receive address (MERCHANT_EVM_ADDRESS). */
  address: string;
  /** Chains to watch, already resolved to effective RPC URLs. */
  chains: FixedChainConfig[];
  pollIntervalMs?: number;
  blockWindow?: number;
  /** Injectable fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export interface FixedAddressWatcherStatus {
  running: boolean;
  address: string;
  chains: string[];
  lastPollAt: number | null;
  lastPollOk: boolean;
  pendingCount: number;
  uptimeSeconds: number;
}

function isHexAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/** Build the 32-byte left-padded topic for an indexed `address` argument. */
function addressTopic(address: string): string {
  return '0x' + address.slice(2).toLowerCase().padStart(64, '0');
}

function hexToBigInt(hex: string): bigint {
  if (!hex || hex === '0x') return 0n;
  return BigInt(hex);
}

interface RpcLog {
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  data: string;
  topics: string[];
}

export class FixedAddressWatcher {
  private readonly storage: StorageAdapter;
  private readonly merchantId: string;
  private readonly address: string;
  private readonly chains: FixedChainConfig[];
  private readonly pollIntervalMs: number;
  private readonly blockWindow: number;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;

  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private rpcId = 0;
  private readonly startedAt = Date.now();
  private lastPollAt: number | null = null;
  private lastPollOk = false;
  private pendingCount = 0;
  /** Per-chain set of `${txHash}:${logIndex}` already processed (dedup). */
  private readonly seen = new Map<Chain, Set<string>>();

  constructor(opts: FixedAddressWatcherOptions) {
    this.storage = opts.storage;
    this.merchantId = opts.merchantId;
    this.address = opts.address;
    this.chains = opts.chains;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.blockWindow = opts.blockWindow ?? DEFAULT_BLOCK_WINDOW;
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

  status(): FixedAddressWatcherStatus {
    return {
      running: !this.stopped,
      address: this.address,
      chains: this.chains.map((ch) => ch.chain),
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
        .catch((err) => this.log.error('fixed_watcher.poll_failed', err))
        .finally(() => this.schedule());
    }, this.pollIntervalMs);
  }

  /** One reconciliation pass across every configured chain. Never throws. */
  async pollOnce(): Promise<void> {
    this.lastPollAt = Date.now();
    if (!isHexAddress(this.address)) {
      this.lastPollOk = false;
      this.log.warn('fixed_watcher.bad_address', { address: this.address });
      return;
    }
    let allOk = true;
    let pendingTotal = 0;
    for (const chain of this.chains) {
      try {
        const pending = await this.pendingForChain(chain.chain);
        pendingTotal += pending.length;
        await this.expireStale(pending);
        const active = pending.filter((inv) => !this.isExpired(inv));
        const ok = await this.scanChain(chain, active);
        if (!ok) allOk = false;
      } catch (err) {
        allOk = false;
        this.log.warn('fixed_watcher.chain_failed', {
          chain: chain.chain,
          err: (err as Error).message,
        });
      }
    }
    this.pendingCount = pendingTotal;
    this.lastPollOk = allOk;
  }

  private async pendingForChain(chain: Chain): Promise<Invoice[]> {
    const pending = await this.storage.listPendingInvoices({ chain });
    // Only invoices that target THIS fixed address belong to fixed mode; an
    // xpub-mode invoice on the same chain has a per-invoice derived address and
    // must never be confirmed by this value-matching watcher.
    return pending.filter(
      (inv) => inv.address.toLowerCase() === this.address.toLowerCase(),
    );
  }

  private isExpired(inv: Invoice): boolean {
    return new Date(inv.expires_at).getTime() < Date.now();
  }

  /** Flip pending fixed invoices past their TTL to `expired`. Best-effort. */
  private async expireStale(pending: Invoice[]): Promise<void> {
    for (const inv of pending) {
      if (this.isExpired(inv)) {
        try {
          await this.storage.updateInvoiceStatus(inv.id, 'expired');
          this.log.info('fixed_watcher.invoice_expired', { invoice_id: inv.id });
        } catch {
          /* best effort */
        }
      }
    }
  }

  /** Returns false when the RPC read failed (poll marked degraded). */
  private async scanChain(chain: FixedChainConfig, active: Invoice[]): Promise<boolean> {
    const latest = await this.blockNumber(chain);
    if (latest === null) return false;
    const fromBlock = latest > BigInt(this.blockWindow) ? latest - BigInt(this.blockWindow) : 0n;
    const logs = await this.getTransferLogs(chain, fromBlock, latest);
    if (logs === null) return false;

    const seen = this.seenFor(chain.chain);
    for (const lg of logs) {
      const key = `${lg.transactionHash}:${lg.logIndex}`;
      if (seen.has(key)) continue;

      const value = hexToBigInt(lg.data);
      const logBlock = hexToBigInt(lg.blockNumber);
      const confirmations = latest >= logBlock ? Number(latest - logBlock) + 1 : 0;
      // Only mark the log as processed once it reaches a TERMINAL decision
      // (confirmed or orphan). A transfer still below minConfirmations is left
      // un-seen so the next poll reprocesses it once it matures — otherwise we
      // would skip it forever and never confirm the invoice.
      const terminal = await this.handleTransfer(
        chain,
        active,
        lg.transactionHash,
        value,
        confirmations,
      );
      if (terminal) seen.add(key);
    }
    return true;
  }

  /** Returns true when the transfer reached a terminal state (confirmed/orphan). */
  private async handleTransfer(
    chain: FixedChainConfig,
    active: Invoice[],
    txHash: string,
    value: bigint,
    confirmations: number,
  ): Promise<boolean> {
    const match = this.findInvoiceByValue(active, value);
    if (!match) {
      this.log.warn('fixed_watcher.orphan_payment', {
        chain: chain.chain,
        address: this.address,
        tx_hash: txHash,
        value: value.toString(),
      });
      await this.emitOrphanWebhook(chain.chain, txHash, value);
      return true;
    }
    if (confirmations < chain.minConfirmations) {
      this.log.info('fixed_watcher.awaiting_confirmations', {
        invoice_id: match.invoice.id,
        confirmations,
        required: chain.minConfirmations,
      });
      return false;
    }
    const confirmed = await this.storage.updateInvoiceStatus(match.invoice.id, 'confirmed', {
      paid_at: new Date().toISOString(),
      tx_hash: txHash,
    });
    await this.emitConfirmedWebhook(confirmed, value, match.nonce);
    this.log.info('fixed_watcher.invoice_confirmed', {
      invoice_id: confirmed.id,
      nonce: match.nonce,
      tx_hash: txHash,
      value: value.toString(),
    });
    return true;
  }

  /**
   * Find the active invoice whose nonce-encoded amount equals the received
   * value. The invoice's stored `amount` IS the exact base+nonce units, so an
   * exact match is authoritative; matchAmount additionally recovers the nonce
   * for the webhook + log.
   */
  private findInvoiceByValue(
    active: Invoice[],
    value: bigint,
  ): { invoice: Invoice; nonce: number } | null {
    for (const inv of active) {
      let amountUnits: bigint;
      try {
        amountUnits = BigInt(inv.amount);
      } catch {
        continue;
      }
      if (amountUnits !== value) continue;
      const base = (amountUnits / BigInt(NONCE_MODULUS)) * BigInt(NONCE_MODULUS);
      const nonce = matchAmount(value, base);
      if (nonce !== null && nonce > 0) return { invoice: inv, nonce };
    }
    return null;
  }

  private seenFor(chain: Chain): Set<string> {
    let s = this.seen.get(chain);
    if (!s) {
      s = new Set<string>();
      this.seen.set(chain, s);
    }
    return s;
  }

  /** eth_blockNumber → latest block as bigint, or null on failure. */
  private async blockNumber(chain: FixedChainConfig): Promise<bigint | null> {
    const result = await this.rpc(chain, 'eth_blockNumber', []);
    if (typeof result !== 'string') return null;
    try {
      return hexToBigInt(result);
    } catch {
      return null;
    }
  }

  private async getTransferLogs(
    chain: FixedChainConfig,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RpcLog[] | null> {
    const params = [
      {
        address: chain.usdcAddress,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        topics: [TRANSFER_TOPIC0, null, addressTopic(this.address)],
      },
    ];
    const result = await this.rpc(chain, 'eth_getLogs', params);
    if (!Array.isArray(result)) return null;
    return result as RpcLog[];
  }

  /** Single JSON-RPC call. Returns the `result` field, or null on any failure. */
  private async rpc(
    chain: FixedChainConfig,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    const body = { jsonrpc: '2.0', id: (this.rpcId += 1), method, params };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(chain.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log.warn('fixed_watcher.rpc_http_error', { chain: chain.chain, status: res.status });
        return null;
      }
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) {
        this.log.warn('fixed_watcher.rpc_error', { chain: chain.chain, err: json.error.message });
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.log.warn('fixed_watcher.rpc_failed', {
        chain: chain.chain,
        rpc: chain.rpcUrl,
        err: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async emitConfirmedWebhook(
    invoice: Invoice,
    valueUnits: bigint,
    nonce: number,
  ): Promise<void> {
    const payload = {
      event: 'invoice.confirmed',
      invoice_id: invoice.id,
      merchant_id: invoice.merchant_id,
      chain: invoice.chain,
      asset: invoice.asset,
      amount: invoice.amount,
      address: invoice.address,
      tx_hash: invoice.tx_hash,
      value: valueUnits.toString(),
      metadata: { mode: 'fixed-address', ref: invoice.id, nonce },
      confirmed_at: invoice.paid_at ?? new Date().toISOString(),
    };
    await this.storage.recordWebhookEvent({
      id: `evt_${randomUUID()}`,
      invoice_id: invoice.id,
      payload_json: JSON.stringify(payload),
      next_retry_at: new Date(Date.now() + WEBHOOK_RETRY_INITIAL_MS).toISOString(),
    });
  }

  /**
   * An inbound transfer that matches no active invoice (expired, or its nonce
   * was recycled) is reported as a `payment.orphan` event so the merchant can
   * decide on a refund. We NEVER activate a plan/invoice off an orphan — the
   * on-chain transfer cannot be refused, so the defense is the checkout screen
   * expiring (hiding the QR at 0:00).
   */
  private async emitOrphanWebhook(chain: Chain, txHash: string, value: bigint): Promise<void> {
    const payload = {
      event: 'payment.orphan',
      merchant_id: this.merchantId,
      chain,
      address: this.address,
      tx_hash: txHash,
      value: value.toString(),
      detected_at: new Date().toISOString(),
    };
    await this.storage.recordWebhookEvent({
      id: `evt_${randomUUID()}`,
      invoice_id: `orphan_${txHash}`,
      payload_json: JSON.stringify(payload),
      next_retry_at: new Date(Date.now() + WEBHOOK_RETRY_INITIAL_MS).toISOString(),
    });
  }
}
