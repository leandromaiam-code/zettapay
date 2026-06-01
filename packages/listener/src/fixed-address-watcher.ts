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

import { createHash } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { Chain, Invoice } from './types.js';
import type { Logger } from './listener.js';
import { matchAmount, NONCE_MODULUS } from './evm-amount-nonce.js';
import {
  decideTransferQuorum,
  quorumThreshold,
  DEFAULT_QUORUM,
  type RpcObservation,
} from './rpc-quorum.js';

/** keccak256("Transfer(address,address,uint256)"). */
const TRANSFER_TOPIC0 =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

const DEFAULT_POLL_INTERVAL_MS = 8_000;
const RPC_TIMEOUT_MS = 10_000;
const WEBHOOK_RETRY_INITIAL_MS = 1_000;
/** Trailing block window scanned each poll. Generous enough to absorb a missed
 *  tick yet bounded so public RPCs don't reject the range. */
const DEFAULT_BLOCK_WINDOW = 200;

/** Canonical stablecoin symbols the fixed-address mode understands. */
export type TokenSymbol = 'USDC' | 'USDT';

/** A single ERC-20 stablecoin contract a chain can receive into the fixed addr. */
export interface EvmTokenSpec {
  /** Asset symbol stored on the invoice + reported in webhooks. */
  symbol: TokenSymbol;
  /** ERC-20 contract address (used in the getLogs filter + EIP-681 URI). */
  address: string;
  /** Token decimals. USDC and USDT on Base both use 6 → the decimal-nonce
   *  encoding (evm-amount-nonce) is identical for both. */
  decimals: number;
}

export interface EvmChainSpec {
  /** Canonical Chain id stored on the invoice + reported in webhooks. */
  chain: Chain;
  /** EIP-155 chain id (used in the EIP-681 payment URI). */
  chainId: number;
  /** Canonical native-USDC token contract (6 decimals). Kept for back-compat;
   *  equals the USDC entry of {@link tokens}. */
  usdcAddress: string;
  /**
   * Stablecoins this chain can receive into the fixed address. The first entry
   * is always USDC (the default asset, so a request with no `asset` behaves
   * exactly as before). A chain may list a SECOND token (e.g. USDT on Base) —
   * an invoice declares which token it expects and a payment in the other token
   * never satisfies it.
   */
  tokens: EvmTokenSpec[];
  /** Public JSON-RPC default; overridable per chain via env. */
  defaultRpcUrl: string;
  /** Env var that overrides defaultRpcUrl. */
  rpcEnvVar: string;
  /** Min confirmations before an inbound transfer is accepted. */
  minConfirmations: number;
}

// Base native-USDC + bridged-USDT contracts. Both 6 decimals, so the
// decimal-nonce amount encoding (evm-amount-nonce.ts) applies identically.
const BASE_USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const BASE_USDT = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const ETH_USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const POLYGON_USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

/**
 * Registry of EVM chains the fixed-address mode understands, keyed by the value
 * a merchant puts in MERCHANT_EVM_CHAINS (csv). Base accepts USDC (default) and
 * USDT as a second token on the SAME chain; ethereum/polygon stay USDC-only.
 */
export const EVM_CHAIN_REGISTRY: Record<string, EvmChainSpec> = {
  base: {
    chain: 'base',
    chainId: 8453,
    usdcAddress: BASE_USDC,
    tokens: [
      { symbol: 'USDC', address: BASE_USDC, decimals: 6 },
      { symbol: 'USDT', address: BASE_USDT, decimals: 6 },
    ],
    defaultRpcUrl: 'https://mainnet.base.org',
    rpcEnvVar: 'BASE_RPC_URL',
    minConfirmations: 1,
  },
  ethereum: {
    chain: 'eth',
    chainId: 1,
    usdcAddress: ETH_USDC,
    tokens: [{ symbol: 'USDC', address: ETH_USDC, decimals: 6 }],
    defaultRpcUrl: 'https://eth.llamarpc.com',
    rpcEnvVar: 'ETHEREUM_RPC_URL',
    minConfirmations: 2,
  },
  polygon: {
    chain: 'polygon',
    chainId: 137,
    usdcAddress: POLYGON_USDC,
    tokens: [{ symbol: 'USDC', address: POLYGON_USDC, decimals: 6 }],
    defaultRpcUrl: 'https://polygon-rpc.com',
    rpcEnvVar: 'POLYGON_RPC_URL',
    minConfirmations: 5,
  },
};

/** Resolve a registry spec from a chain alias (case-insensitive). */
export function lookupEvmChain(alias: string): EvmChainSpec | null {
  return EVM_CHAIN_REGISTRY[alias.trim().toLowerCase()] ?? null;
}

/** The default token of a chain (always USDC — the first entry). */
export function defaultEvmToken(spec: EvmChainSpec): EvmTokenSpec {
  return spec.tokens.find((t) => t.symbol === 'USDC') ?? spec.tokens[0]!;
}

/**
 * Resolve the token a chain receives for a given asset alias ('usdc' | 'usdt',
 * case-insensitive). Defaults to USDC when the alias is empty. Returns null when
 * the chain does not list that token (e.g. USDT on a USDC-only chain), so the
 * caller can reject the request rather than silently fall back.
 */
export function lookupEvmToken(spec: EvmChainSpec, asset: string | undefined): EvmTokenSpec | null {
  const sym = (asset ?? 'usdc').trim().toLowerCase();
  return spec.tokens.find((t) => t.symbol.toLowerCase() === sym) ?? null;
}

/**
 * Parse MERCHANT_EVM_TOKENS ("usdc,usdt") into a deduped, lowercased alias list,
 * defaulting to ['usdc']. Unknown aliases are dropped (a typo never crashes
 * boot); USDC is always implied so a fixed-address deployment keeps working
 * unchanged when the var is unset.
 */
export function parseEvmTokens(csv: string | undefined): TokenSymbol[] {
  const raw = (csv ?? 'usdc')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const out: TokenSymbol[] = [];
  const seen = new Set<string>();
  for (const alias of raw.length ? raw : ['usdc']) {
    const sym = alias === 'usdt' ? 'USDT' : alias === 'usdc' ? 'USDC' : null;
    if (sym && !seen.has(sym)) {
      seen.add(sym);
      out.push(sym);
    }
  }
  if (!out.includes('USDC')) out.unshift('USDC');
  return out;
}

/**
 * Deterministic webhook event id (Z76 FIX 5). The id surfaces to the merchant
 * as the `X-ZettaPay-Event-Id` header; making it a stable function of the event
 * key (rather than a random UUID) means a re-detection after a listener restart
 * produces the SAME id, so the merchant can deduplicate idempotently. Truncated
 * SHA-256 over a domain-separated key.
 */
export function deterministicEventId(key: string): string {
  return `evt_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
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
  /** Effective RPC URL after env override (primary; first of the quorum list). */
  rpcUrl: string;
  /**
   * Full quorum endpoint list (Z76 FIX 2). When 2+ entries, a confirmation
   * requires {@link quorumThreshold} of them to agree. When omitted/empty the
   * watcher falls back to `[rpcUrl]` (single source) so older callers and tests
   * keep working unchanged.
   */
  rpcUrls?: string[];
  /**
   * Tokens this merchant accepts on the chain (Z77). When omitted/empty the
   * watcher scans only the chain's default USDC token, so older callers and
   * tests behave exactly as before USDT existed. With 2+ entries (e.g. USDC +
   * USDT on Base) each token is scanned and matched independently.
   */
  enabledTokens?: EvmTokenSpec[];
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
  /** Agreeing-RPC count required to confirm when 2+ endpoints are configured. */
  quorum?: number;
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
  private readonly quorum: number;
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
    this.quorum = opts.quorum ?? DEFAULT_QUORUM;
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

  /** Endpoints to cross-check for this chain (quorum list, or single fallback). */
  private rpcUrlsFor(chain: FixedChainConfig): string[] {
    return chain.rpcUrls && chain.rpcUrls.length > 0 ? chain.rpcUrls : [chain.rpcUrl];
  }

  /** Tokens to scan on a chain: the merchant's enabled set, or USDC only. */
  private tokensToScan(chain: FixedChainConfig): EvmTokenSpec[] {
    return chain.enabledTokens && chain.enabledTokens.length > 0
      ? chain.enabledTokens
      : [defaultEvmToken(chain)];
  }

  /**
   * Scan every enabled token on a chain independently (Z77). Each token gets its
   * own RPC quorum pass over its OWN contract logs, matched only against
   * invoices that requested that exact token — a USDT payment never satisfies a
   * USDC invoice and vice versa. A single-token (USDC-only) chain behaves
   * exactly as before.
   */
  private async scanChain(chain: FixedChainConfig, active: Invoice[]): Promise<boolean> {
    let allOk = true;
    for (const token of this.tokensToScan(chain)) {
      const forToken = active.filter(
        (inv) => inv.asset.toUpperCase() === token.symbol,
      );
      const ok = await this.scanToken(chain, token, forToken);
      if (!ok) allOk = false;
    }
    return allOk;
  }

  /**
   * Cross-check every configured RPC and confirm a transfer of ONE token ONLY
   * when a quorum of them agrees on the same (tx, value) with enough
   * confirmations (Z76 FIX 2). Returns false when the poll is DEGRADED — fewer
   * RPCs responded than the quorum requires — so a lone (possibly hostile)
   * source can never decide.
   */
  private async scanToken(
    chain: FixedChainConfig,
    token: EvmTokenSpec,
    active: Invoice[],
  ): Promise<boolean> {
    const urls = this.rpcUrlsFor(chain);
    const threshold = quorumThreshold(urls.length, this.quorum);
    const scans = await Promise.all(urls.map((url) => this.scanOneRpc(url, chain, token)));
    const responded = scans.filter((s): s is { latest: bigint; logs: RpcLog[] } => s !== null);

    if (responded.length < threshold) {
      this.log.warn('fixed_watcher.rpc_quorum_degraded', {
        chain: chain.chain,
        asset: token.symbol,
        responded: responded.length,
        required: threshold,
        configured: urls.length,
      });
      return false;
    }

    // Aggregate per-transfer observations across the responding RPCs. Each RPC
    // computes confirmations against ITS OWN latest block; the quorum takes the
    // most-agreed value and the minimum confirmation depth among agreeing RPCs.
    const byKey = new Map<string, { txHash: string; observations: RpcObservation[] }>();
    for (const scan of responded) {
      for (const lg of scan.logs) {
        const key = `${lg.transactionHash}:${lg.logIndex}`;
        const value = hexToBigInt(lg.data);
        const logBlock = hexToBigInt(lg.blockNumber);
        const confirmations = scan.latest >= logBlock ? Number(scan.latest - logBlock) + 1 : 0;
        let entry = byKey.get(key);
        if (!entry) {
          entry = { txHash: lg.transactionHash, observations: [] };
          byKey.set(key, entry);
        }
        entry.observations.push({ value, confirmations });
      }
    }

    // Dedup key is scoped per token so the same logIndex on two contracts can
    // never collide.
    const seen = this.seenFor(chain.chain);
    for (const [logKey, entry] of byKey) {
      const key = `${token.symbol}:${logKey}`;
      if (seen.has(key)) continue;
      const decision = decideTransferQuorum(entry.observations, threshold);
      if (decision.status === 'conflict') {
        // RPCs report DIFFERENT values for the same tx — a possible forgery by
        // one source. Never confirm; leave un-seen so an honest majority can
        // still form on a later poll.
        this.log.warn('fixed_watcher.rpc_quorum_conflict', {
          chain: chain.chain,
          asset: token.symbol,
          tx_hash: entry.txHash,
          agree: decision.agree,
          required: threshold,
        });
        continue;
      }
      if (decision.status === 'insufficient') {
        // A single value but not enough reporters yet (propagation lag). Wait.
        continue;
      }
      // Quorum agreed. Mark seen only once the transfer reaches a TERMINAL
      // decision (confirmed/orphan); a value below minConfirmations stays
      // un-seen so a later poll reprocesses it once it matures.
      const terminal = await this.handleTransfer(
        chain,
        token,
        active,
        entry.txHash,
        decision.value,
        decision.confirmations,
      );
      if (terminal) seen.add(key);
    }
    return true;
  }

  /** Read latest block + Transfer logs for ONE token from ONE endpoint. */
  private async scanOneRpc(
    url: string,
    chain: FixedChainConfig,
    token: EvmTokenSpec,
  ): Promise<{ latest: bigint; logs: RpcLog[] } | null> {
    const latest = await this.blockNumber(url, chain);
    if (latest === null) return null;
    const fromBlock = latest > BigInt(this.blockWindow) ? latest - BigInt(this.blockWindow) : 0n;
    const logs = await this.getTransferLogs(url, chain, token, fromBlock, latest);
    if (logs === null) return null;
    return { latest, logs };
  }

  /** Returns true when the transfer reached a terminal state (confirmed/orphan). */
  private async handleTransfer(
    chain: FixedChainConfig,
    token: EvmTokenSpec,
    active: Invoice[],
    txHash: string,
    value: bigint,
    confirmations: number,
  ): Promise<boolean> {
    const match = this.findInvoiceByValue(active, value);
    if (!match) {
      this.log.warn('fixed_watcher.orphan_payment', {
        chain: chain.chain,
        asset: token.symbol,
        address: this.address,
        tx_hash: txHash,
        value: value.toString(),
      });
      await this.emitOrphanWebhook(chain.chain, token, txHash, value);
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
    await this.emitConfirmedWebhook(confirmed, token, value, match.nonce);
    this.log.info('fixed_watcher.invoice_confirmed', {
      invoice_id: confirmed.id,
      asset: token.symbol,
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
  private async blockNumber(url: string, chain: FixedChainConfig): Promise<bigint | null> {
    const result = await this.rpc(url, chain, 'eth_blockNumber', []);
    if (typeof result !== 'string') return null;
    try {
      return hexToBigInt(result);
    } catch {
      return null;
    }
  }

  private async getTransferLogs(
    url: string,
    chain: FixedChainConfig,
    token: EvmTokenSpec,
    fromBlock: bigint,
    toBlock: bigint,
  ): Promise<RpcLog[] | null> {
    const params = [
      {
        address: token.address,
        fromBlock: '0x' + fromBlock.toString(16),
        toBlock: '0x' + toBlock.toString(16),
        topics: [TRANSFER_TOPIC0, null, addressTopic(this.address)],
      },
    ];
    const result = await this.rpc(url, chain, 'eth_getLogs', params);
    if (!Array.isArray(result)) return null;
    return result as RpcLog[];
  }

  /**
   * Single JSON-RPC call against ONE endpoint. Returns the `result` field, or
   * null on any failure (HTTP error, RPC error, timeout, network). A single
   * endpoint failing never throws — the quorum tolerates it via the other
   * endpoints.
   */
  private async rpc(
    url: string,
    chain: FixedChainConfig,
    method: string,
    params: unknown[],
  ): Promise<unknown> {
    const body = { jsonrpc: '2.0', id: (this.rpcId += 1), method, params };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        this.log.warn('fixed_watcher.rpc_http_error', {
          chain: chain.chain,
          rpc: url,
          status: res.status,
        });
        return null;
      }
      const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
      if (json.error) {
        this.log.warn('fixed_watcher.rpc_error', {
          chain: chain.chain,
          rpc: url,
          err: json.error.message,
        });
        return null;
      }
      return json.result ?? null;
    } catch (err) {
      this.log.warn('fixed_watcher.rpc_failed', {
        chain: chain.chain,
        rpc: url,
        err: (err as Error).message,
      });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async emitConfirmedWebhook(
    invoice: Invoice,
    token: EvmTokenSpec,
    valueUnits: bigint,
    nonce: number,
  ): Promise<void> {
    const payload = {
      event: 'invoice.confirmed',
      invoice_id: invoice.id,
      merchant_id: invoice.merchant_id,
      chain: invoice.chain,
      asset: invoice.asset,
      token_address: token.address,
      amount: invoice.amount,
      address: invoice.address,
      tx_hash: invoice.tx_hash,
      value: valueUnits.toString(),
      metadata: { mode: 'fixed-address', ref: invoice.id, nonce, asset: token.symbol },
      confirmed_at: invoice.paid_at ?? new Date().toISOString(),
    };
    await this.storage.recordWebhookEvent({
      id: deterministicEventId(`${invoice.id}:confirmed`),
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
  private async emitOrphanWebhook(
    chain: Chain,
    token: EvmTokenSpec,
    txHash: string,
    value: bigint,
  ): Promise<void> {
    const payload = {
      event: 'payment.orphan',
      merchant_id: this.merchantId,
      chain,
      asset: token.symbol,
      token_address: token.address,
      address: this.address,
      tx_hash: txHash,
      value: value.toString(),
      detected_at: new Date().toISOString(),
    };
    await this.storage.recordWebhookEvent({
      id: deterministicEventId(`orphan:${chain}:${token.symbol}:${txHash}`),
      invoice_id: `orphan_${txHash}`,
      payload_json: JSON.stringify(payload),
      next_retry_at: new Date(Date.now() + WEBHOOK_RETRY_INITIAL_MS).toISOString(),
    });
  }
}
