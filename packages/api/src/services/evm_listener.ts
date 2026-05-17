// Z47 — EVM USDC listener (Base in Z47, Polygon in Z47.2).
//
// Watches the canonical USDC ERC-20 Transfer event on a target EVM chain for
// any address in the active invoice set. ZettaPay is non-custodial: there is
// no payer key, no relayer, no facilitator transfer. Each invoice has a
// HD-derived receive address (Z45). When a Transfer with `to` == that address
// and `value` == invoice.amount_native fires, we record the match and start
// counting confirmations until chain finality (12 blocks on Base, 128 on
// Polygon PoS).
//
// The listener is intentionally chain-scoped: instantiate one EvmListener per
// chain (Base mainnet, Base Sepolia, Polygon PoS, Polygon Amoy).

import {
  createPublicClient,
  http,
  parseAbiItem,
  type Address,
  type Log,
  type PublicClient,
} from "viem";
import { base, baseSepolia, polygon, polygonAmoy } from "viem/chains";

export type EvmListenerChain =
  | "base"
  | "base-sepolia"
  | "polygon"
  | "polygon-amoy";

/**
 * @deprecated Kept for compatibility with early Z47 callers that imported
 * `BaseListenerChain` before Polygon support landed. New code should reference
 * {@link EvmListenerChain} directly.
 */
export type BaseListenerChain = EvmListenerChain;

/** Canonical Circle-native USDC on Base mainnet (6 decimals). */
export const USDC_BASE_MAINNET: Address =
  "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Circle testnet USDC on Base Sepolia (6 decimals). */
export const USDC_BASE_SEPOLIA: Address =
  "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

/** Canonical Circle-native USDC on Polygon PoS mainnet (6 decimals). */
export const USDC_POLYGON_MAINNET: Address =
  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";

/** Circle testnet USDC on Polygon Amoy (6 decimals). */
export const USDC_POLYGON_AMOY: Address =
  "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";

/** Base finality target — 12 blocks ≈ 24s at 2s slot time. */
export const BASE_FINALITY_BLOCKS = 12;

/** Polygon PoS finality target — 128 blocks ≈ 4-5 min at 2s block time. */
export const POLYGON_FINALITY_BLOCKS = 128;

/** Backfill window on boot — getLogs from `head - BACKFILL_BLOCK_RANGE`. */
export const BACKFILL_BLOCK_RANGE = 1_000n;

/** Debounce for active-set refreshes — coalesces invoice creates within 2s. */
export const REFRESH_DEBOUNCE_MS = 2_000;

/** Re-subscribe delay after `watchContractEvent` reports an error. */
export const RECONNECT_DELAY_MS = 5_000;

export const ERC20_TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 value)",
);

/**
 * Minimal projection of a `public.zettapay_invoices` row used by the listener.
 * `amountNative` is the atomic-unit USDC amount (decimals=6) the payer must
 * send for the Transfer to count as a match.
 */
export interface PendingInvoice {
  id: string;
  chain: EvmListenerChain;
  receiveAddress: Address;
  amountNative: bigint;
  requiredConfirmations: number;
}

export interface MatchedTx {
  hash: `0x${string}`;
  blockNumber: bigint;
}

/**
 * Pluggable persistence boundary. Implementations either talk to Supabase
 * (`SupabaseInvoiceStore`) in production or use an in-memory map for tests.
 * No method may throw on the happy path — failures surface to the caller
 * via the returned promise and are logged by the listener.
 */
export interface InvoiceStore {
  /** Pending invoices on `chain` (status='pending', tx_hash IS NULL). */
  listPending(chain: EvmListenerChain): Promise<PendingInvoice[]>;
  /** Bind the first observed match — set tx_hash + confirmations=1. */
  markMatched(invoiceId: string, tx: MatchedTx): Promise<void>;
  /** Bump the confirmation count for an already-matched invoice. */
  updateConfirmations(invoiceId: string, confirmations: number): Promise<void>;
  /** Promote to status='confirmed' after `requiredConfirmations` reached. */
  markConfirmed(invoiceId: string, confirmedAt: Date): Promise<void>;
}

type TransferLog = Log<bigint, number, false, typeof ERC20_TRANSFER_EVENT, true>;

export interface ListenerLogger {
  info: (event: string, fields?: Record<string, unknown>) => void;
  warn: (event: string, fields?: Record<string, unknown>) => void;
  error: (event: string, fields?: Record<string, unknown>) => void;
}

/** Test seam — minimal subset of viem PublicClient the listener consumes. */
export interface ListenerPublicClient {
  getBlockNumber(): Promise<bigint>;
  getLogs(args: {
    address: Address;
    event: typeof ERC20_TRANSFER_EVENT;
    args?: { to?: readonly Address[] };
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<TransferLog[]>;
  watchContractEvent(args: {
    address: Address;
    abi: readonly unknown[];
    eventName: "Transfer";
    args?: { to?: readonly Address[] };
    onLogs: (logs: TransferLog[]) => void;
    onError?: (err: Error) => void;
  }): () => void;
  waitForTransactionReceipt(args: {
    hash: `0x${string}`;
    confirmations?: number;
  }): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
}

export interface EvmListenerOptions {
  chain: EvmListenerChain;
  /** Public RPC URL — Alchemy/QuickNode tier or the chain's free RPC. */
  rpcUrl?: string;
  /** ERC-20 contract; defaults to the canonical USDC for the chosen chain. */
  contractAddress?: Address;
  /** Persistence boundary. */
  store: InvoiceStore;
  /** Test seam — when omitted, a viem PublicClient is built from `rpcUrl`. */
  publicClient?: ListenerPublicClient;
  /**
   * Override the confirmation count used as the listener-wide finality target.
   * Defaults to the chain's canonical finality: 12 blocks for Base, 128 for
   * Polygon PoS (per-invoice `requiredConfirmations` still wins for tier
   * policies in {@link PendingInvoice.requiredConfirmations}).
   */
  finalityBlocks?: number;
  /** Default 1000 — number of blocks to scan on boot for missed transfers. */
  backfillRange?: bigint;
  /** Default 2000 ms — debounce window for refreshActive() requests. */
  refreshDebounceMs?: number;
  /** Default 5000 ms — delay before re-subscribing on watchContractEvent error. */
  reconnectDelayMs?: number;
  logger?: ListenerLogger;
  /** Test hooks. */
  hooks?: {
    onMatched?: (invoice: PendingInvoice, tx: MatchedTx) => void;
    onConfirmed?: (invoice: PendingInvoice) => void;
    onError?: (err: Error) => void;
    onResubscribed?: () => void;
  };
}

const ERC20_ABI = [
  {
    type: "event",
    name: "Transfer",
    anonymous: false,
    inputs: [
      { type: "address", name: "from", indexed: true },
      { type: "address", name: "to", indexed: true },
      { type: "uint256", name: "value", indexed: false },
    ],
  },
] as const;

const NULL_LOGGER: ListenerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * `EvmListener` is the per-chain runtime. Boot order:
 *
 *   1. `refreshActive()` — pull every pending invoice from the store and
 *      build the address → invoice map.
 *   2. `backfill()` — `getLogs` against the contract for any Transfer to one
 *      of the active addresses in the last `backfillRange` blocks. Catches
 *      payments that landed while the process was down.
 *   3. `subscribe()` — `watchContractEvent` for the live tail. On error the
 *      listener self-reconnects after `reconnectDelayMs`.
 *
 * Concurrency note: every match runs `markMatched` then awaits
 * `waitForTransactionReceipt({ confirmations })` in the background. The
 * background promise is fire-and-forget so a slow chain doesn't block the
 * subscription. Errors land in `logger.error` and `hooks.onError`.
 */
export class EvmListener {
  private readonly options: Required<
    Omit<EvmListenerOptions, "publicClient" | "logger" | "hooks">
  > & {
    publicClient: ListenerPublicClient;
    logger: ListenerLogger;
    hooks: NonNullable<EvmListenerOptions["hooks"]>;
  };

  private active: Map<string, PendingInvoice> = new Map();
  private unwatch: (() => void) | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Invoices we've already bound to a tx — prevents duplicate markMatched. */
  private matched: Set<string> = new Set();
  private stopped = false;

  constructor(opts: EvmListenerOptions) {
    const contractAddress =
      opts.contractAddress ?? defaultUsdcContract(opts.chain);
    const rpcUrl = opts.rpcUrl ?? defaultRpcUrl(opts.chain);
    const publicClient =
      opts.publicClient ?? (buildViemClient(opts.chain, rpcUrl) as ListenerPublicClient);
    this.options = {
      chain: opts.chain,
      rpcUrl,
      contractAddress,
      store: opts.store,
      finalityBlocks: opts.finalityBlocks ?? defaultFinalityBlocks(opts.chain),
      backfillRange: opts.backfillRange ?? BACKFILL_BLOCK_RANGE,
      refreshDebounceMs: opts.refreshDebounceMs ?? REFRESH_DEBOUNCE_MS,
      reconnectDelayMs: opts.reconnectDelayMs ?? RECONNECT_DELAY_MS,
      publicClient,
      logger: opts.logger ?? NULL_LOGGER,
      hooks: opts.hooks ?? {},
    };
  }

  /** Boot order: refresh → backfill → subscribe. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.refreshActive();
    await this.backfill();
    this.subscribe();
    this.options.logger.info("evm_listener.started", {
      chain: this.options.chain,
      contract: this.options.contractAddress,
      active: this.active.size,
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    this.options.logger.info("evm_listener.stopped", { chain: this.options.chain });
  }

  /**
   * External entry point fired by the invoice-creation pipeline: a new
   * `pending` invoice has been written and the listener should pick it up
   * within `refreshDebounceMs`. Multiple calls within the window collapse to
   * one refresh + one re-subscription, so a burst of invoice creates does
   * not hammer the RPC.
   */
  requestRefresh(): void {
    if (this.stopped) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.refreshAndResubscribe().catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        this.options.logger.error("evm_listener.refresh_failed", {
          message: error.message,
        });
        this.options.hooks.onError?.(error);
      });
    }, this.options.refreshDebounceMs);
  }

  /** Pull the active invoice set from the store. Public for test rigging. */
  async refreshActive(): Promise<void> {
    const pending = await this.options.store.listPending(this.options.chain);
    const next = new Map<string, PendingInvoice>();
    for (const inv of pending) {
      next.set(normaliseAddress(inv.receiveAddress), inv);
    }
    this.active = next;
  }

  /**
   * `getLogs` over the last `backfillRange` blocks for any Transfer whose
   * `to` is in the active set. Runs once on boot so a payment that landed
   * during a listener restart is not lost. No-op when the active set is empty.
   */
  async backfill(): Promise<void> {
    if (this.active.size === 0) return;
    const head = await this.options.publicClient.getBlockNumber();
    const fromBlock =
      head > this.options.backfillRange
        ? head - this.options.backfillRange
        : 0n;
    const toAddresses = [...this.active.values()].map(
      (inv) => inv.receiveAddress,
    );
    const logs = await this.options.publicClient.getLogs({
      address: this.options.contractAddress,
      event: ERC20_TRANSFER_EVENT,
      args: { to: toAddresses },
      fromBlock,
      toBlock: head,
    });
    this.options.logger.info("evm_listener.backfill", {
      chain: this.options.chain,
      fromBlock: fromBlock.toString(),
      toBlock: head.toString(),
      candidates: logs.length,
    });
    for (const log of logs) {
      await this.handleLog(log);
    }
  }

  /**
   * Subscribe to the live tail. We pass the full ERC-20 ABI for viem to
   * encode the topic filter; the indexed `to` argument is the canonical
   * filter so the RPC pre-filters on the server side.
   */
  private subscribe(): void {
    if (this.stopped) return;
    if (this.unwatch) {
      this.unwatch();
      this.unwatch = null;
    }
    const toAddresses = [...this.active.values()].map(
      (inv) => inv.receiveAddress,
    );
    this.unwatch = this.options.publicClient.watchContractEvent({
      address: this.options.contractAddress,
      abi: ERC20_ABI,
      eventName: "Transfer",
      args: toAddresses.length > 0 ? { to: toAddresses } : undefined,
      onLogs: (logs) => {
        for (const log of logs) {
          this.handleLog(log).catch((err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            this.options.logger.error("evm_listener.log_handler_failed", {
              message: error.message,
            });
            this.options.hooks.onError?.(error);
          });
        }
      },
      onError: (err) => {
        this.options.logger.warn("evm_listener.watch_error", {
          message: err.message,
        });
        this.options.hooks.onError?.(err);
        if (this.stopped) return;
        setTimeout(() => {
          if (this.stopped) return;
          this.subscribe();
        }, this.options.reconnectDelayMs);
      },
    });
  }

  private async refreshAndResubscribe(): Promise<void> {
    await this.refreshActive();
    this.subscribe();
    this.options.hooks.onResubscribed?.();
  }

  /**
   * Match policy: `to` == receive_address (case-insensitive) AND
   * `value` == amount_native. Both must match — partial payments are
   * ignored on purpose. The first match wins; later transfers to the same
   * address are no-ops once the invoice has a bound tx_hash.
   */
  async handleLog(log: TransferLog): Promise<void> {
    const to = log.args?.to;
    const value = log.args?.value;
    if (!to || value === undefined) return;
    const invoice = this.active.get(normaliseAddress(to));
    if (!invoice) return;
    if (value !== invoice.amountNative) {
      this.options.logger.info("evm_listener.amount_mismatch", {
        invoiceId: invoice.id,
        expected: invoice.amountNative.toString(),
        received: value.toString(),
      });
      return;
    }
    if (this.matched.has(invoice.id)) return;
    if (!log.transactionHash || log.blockNumber === null) return;
    this.matched.add(invoice.id);

    const tx: MatchedTx = {
      hash: log.transactionHash,
      blockNumber: log.blockNumber,
    };
    try {
      await this.options.store.markMatched(invoice.id, tx);
    } catch (err) {
      this.matched.delete(invoice.id);
      throw err;
    }
    this.options.logger.info("evm_listener.matched", {
      invoiceId: invoice.id,
      tx: tx.hash,
      blockNumber: tx.blockNumber.toString(),
    });
    this.options.hooks.onMatched?.(invoice, tx);
    void this.trackConfirmations(invoice, tx);
  }

  /**
   * Block until `waitForTransactionReceipt` returns with at least
   * `requiredConfirmations` confirmations, then promote the invoice. Errors
   * are logged but don't crash the listener — the next backfill pass will
   * re-discover the tx and retry. We use the invoice's own
   * `requiredConfirmations` (rather than the global finality target) so
   * future per-amount policies (low-value 1 conf, high-value 12 conf) just
   * work by changing the column.
   */
  private async trackConfirmations(
    invoice: PendingInvoice,
    tx: MatchedTx,
  ): Promise<void> {
    const confirmations = Math.max(
      1,
      invoice.requiredConfirmations || this.options.finalityBlocks,
    );
    try {
      const receipt = await this.options.publicClient.waitForTransactionReceipt({
        hash: tx.hash,
        confirmations,
      });
      if (receipt.status !== "success") {
        this.options.logger.warn("evm_listener.tx_reverted", {
          invoiceId: invoice.id,
          tx: tx.hash,
        });
        return;
      }
      await this.options.store.updateConfirmations(invoice.id, confirmations);
      await this.options.store.markConfirmed(invoice.id, new Date());
      this.options.logger.info("evm_listener.confirmed", {
        invoiceId: invoice.id,
        tx: tx.hash,
        confirmations,
      });
      this.options.hooks.onConfirmed?.(invoice);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.options.logger.error("evm_listener.confirmation_failed", {
        invoiceId: invoice.id,
        tx: tx.hash,
        message: error.message,
      });
      this.options.hooks.onError?.(error);
    }
  }

  /** Snapshot of the address → invoice map, for tests + observability. */
  getActiveInvoiceCount(): number {
    return this.active.size;
  }

  /** Snapshot of matched invoice IDs — for tests. */
  hasMatched(invoiceId: string): boolean {
    return this.matched.has(invoiceId);
  }
}

function normaliseAddress(address: Address | string): string {
  return address.toLowerCase();
}

function defaultUsdcContract(chain: EvmListenerChain): Address {
  switch (chain) {
    case "base":
      return USDC_BASE_MAINNET;
    case "base-sepolia":
      return USDC_BASE_SEPOLIA;
    case "polygon":
      return USDC_POLYGON_MAINNET;
    case "polygon-amoy":
      return USDC_POLYGON_AMOY;
  }
}

function defaultRpcUrl(chain: EvmListenerChain): string {
  switch (chain) {
    case "base":
      return "https://mainnet.base.org";
    case "base-sepolia":
      return "https://sepolia.base.org";
    case "polygon":
      return "https://polygon-rpc.com";
    case "polygon-amoy":
      return "https://rpc-amoy.polygon.technology";
  }
}

function defaultFinalityBlocks(chain: EvmListenerChain): number {
  switch (chain) {
    case "base":
    case "base-sepolia":
      return BASE_FINALITY_BLOCKS;
    case "polygon":
    case "polygon-amoy":
      return POLYGON_FINALITY_BLOCKS;
  }
}

function buildViemClient(
  chain: EvmListenerChain,
  rpcUrl: string,
): PublicClient {
  let viemChain;
  switch (chain) {
    case "base":
      viemChain = base;
      break;
    case "base-sepolia":
      viemChain = baseSepolia;
      break;
    case "polygon":
      viemChain = polygon;
      break;
    case "polygon-amoy":
      viemChain = polygonAmoy;
      break;
  }
  return createPublicClient({ chain: viemChain, transport: http(rpcUrl) });
}
