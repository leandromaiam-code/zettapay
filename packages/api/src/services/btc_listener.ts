/**
 * Z46 — BTC payment listener.
 *
 * Watches each pending BTC invoice's receive address (BIP-84 P2WPKH derived
 * by Z45's KeyManager) for inbound transactions via mempool.space's free
 * WebSocket. Reconciles confirmations against the per-invoice tier policy
 * (1 / 3 / 6 confs for <$50 / <$500 / >=$500) and reverts to pending if a
 * confirmed transaction gets reorged out of the chain.
 *
 * Mempool.space is "free tier infinito" for read-only WS + REST — no auth
 * token, no per-IP cap on subscriptions, no per-address quota. The whole
 * point of the Z45 pivot is to lean on this to keep per-invoice cost zero.
 *
 * Wire format (https://mempool.space/docs/api):
 *
 *   client -> server (JSON over wss://mempool.space/api/v1/ws):
 *     { "action": "want", "data": ["blocks"] }      // tip-bump events
 *     { "track-address": "bc1q..." }                // one address per frame
 *
 *   server -> client:
 *     { "address-transactions": [ TxLike, ... ] }
 *     { "block": { "height": number, "id": string } }
 *
 *   REST (used for boot backfill + cutover when WS down):
 *     GET /api/address/{addr}/utxo  -> MempoolUtxo[]
 *     GET /api/tx/{txid}            -> MempoolTxDetail
 *     GET /api/blocks/tip/height    -> number (plain text)
 *
 * The listener accepts a fully injectable WebSocket factory + REST client
 * + InvoiceStore so unit tests can drive every state transition without
 * touching the network. The `Defaults` export wires them to the real
 * Node `WebSocket` and `fetch` for production callers.
 */

export type BtcInvoiceStatus = "pending" | "confirmed" | "expired" | "swept";

/**
 * Minimal projection of `public.zettapay_invoices` rows the listener needs.
 * The listener never inserts or expires invoices — those belong to the
 * admin endpoint (Z45) and the sweep cron (Z48) respectively.
 */
export interface BtcInvoiceRecord {
  id: string;
  receive_address: string;
  /** Decimal-string BTC amount (e.g. "0.00012500"). Compared exactly. */
  amount_native: string;
  amount_usd: number;
  required_confirmations: number;
  status: BtcInvoiceStatus;
  tx_hash: string | null;
  confirmations: number;
  /** ISO-8601 UTC expiry timestamp. */
  expires_at: string;
}

export interface InvoiceStore {
  /** All pending BTC invoices that have not yet been confirmed/expired/swept. */
  listPendingBtc(): Promise<BtcInvoiceRecord[]>;
  /**
   * Single-row lookup keyed on `(chain='btc', receive_address)` —
   * UNIQUE in the schema so this returns at most one record.
   */
  findBtcByAddress(address: string): Promise<BtcInvoiceRecord | null>;
  /** First-time match: invoice is still pending, tx is now known. */
  recordIncomingTx(args: {
    invoiceId: string;
    txHash: string;
    confirmations: number;
  }): Promise<void>;
  /** Tx already known, confirmation count moved (but not enough yet). */
  bumpConfirmations(args: {
    invoiceId: string;
    confirmations: number;
  }): Promise<void>;
  /** Confirmation threshold reached: flip status -> confirmed. */
  markConfirmed(args: {
    invoiceId: string;
    confirmations: number;
  }): Promise<void>;
  /**
   * Reorg: the previously-confirmed tx is no longer in the canonical chain.
   * Reset status to pending and clear the tx fields so the listener picks
   * the replacement up on the next event.
   */
  revertToPending(args: { invoiceId: string }): Promise<void>;
}

export interface MempoolUtxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface MempoolTxDetail {
  txid: string;
  vout: Array<{ scriptpubkey_address?: string; value: number }>;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface MempoolApiClient {
  fetchAddressUtxos(addr: string): Promise<MempoolUtxo[]>;
  fetchTxDetail(txid: string): Promise<MempoolTxDetail | null>;
  fetchTipHeight(): Promise<number>;
}

/** DOM-compatible subset of WebSocket; assignable from `ws` or globalThis.WebSocket. */
export interface MempoolWebSocketLike {
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type WebSocketFactory = (url: string) => MempoolWebSocketLike;

export type ListenerLogger = (
  level: "info" | "warn" | "error",
  msg: string,
  meta?: Record<string, unknown>,
) => void;

export interface BtcListenerOptions {
  store: InvoiceStore;
  api: MempoolApiClient;
  wsFactory: WebSocketFactory;
  wsUrl?: string;
  /**
   * Reconnect schedule in ms after each successive WS drop. Per spec:
   * 1s, 5s, 30s, 5min, then sticky at 5min. Injectable so tests can
   * collapse the schedule.
   */
  reconnectBackoffMs?: number[];
  /**
   * Time the WS may stay down before the REST poll loop kicks in to keep
   * invoices flowing. Per spec: 5 min.
   */
  wsDownCutoverMs?: number;
  /** REST poll cadence while in fallback mode. Per spec: 30s. */
  restPollIntervalMs?: number;
  /** Logger; defaults to a no-op so the service is silent under test. */
  logger?: ListenerLogger;
  /** Injectable timers for fake-clock tests. */
  setTimeout?: (cb: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Optional callback fired when an invoice flips to confirmed. */
  onConfirmed?: (invoice: BtcInvoiceRecord, txHash: string) => void | Promise<void>;
}

const MEMPOOL_DEFAULT_WS_URL = "wss://mempool.space/api/v1/ws";
const DEFAULT_BACKOFF_MS = [1_000, 5_000, 30_000, 300_000];
const DEFAULT_WS_DOWN_CUTOVER_MS = 300_000;
const DEFAULT_REST_POLL_INTERVAL_MS = 30_000;
const SATS_PER_BTC = 100_000_000n;

/** 1 / 3 / 6 confirmations tiered by USD value (spec §confirmation policy). */
export function requiredConfirmationsForUsd(amountUsd: number): number {
  if (!Number.isFinite(amountUsd) || amountUsd < 0) {
    throw new Error("requiredConfirmationsForUsd: amountUsd must be a non-negative finite number");
  }
  if (amountUsd < 50) return 1;
  if (amountUsd < 500) return 3;
  return 6;
}

/**
 * Convert a decimal-string BTC amount (e.g. "0.00012500") to integer sats.
 * Rejects scientific notation, more than 8 fractional digits, and negatives
 * — we never want fuzzy floating-point math near payment matching.
 */
export function btcDecimalToSats(amount: string): bigint {
  if (typeof amount !== "string" || amount.length === 0) {
    throw new Error("btcDecimalToSats: amount must be a non-empty string");
  }
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(`btcDecimalToSats: invalid BTC decimal "${amount}"`);
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = (frac + "00000000").slice(0, 8);
  return BigInt(whole) * SATS_PER_BTC + BigInt(padded);
}

/** Sum the sat value of vouts paying to a specific address. */
export function sumPaymentToAddress(
  tx: Pick<MempoolTxDetail, "vout">,
  address: string,
): bigint {
  let total = 0n;
  for (const out of tx.vout) {
    if (out.scriptpubkey_address === address) {
      total += BigInt(out.value);
    }
  }
  return total;
}

/**
 * Internal listener state — kept on the instance so tests can assert it
 * after driving events through the public API.
 */
interface ListenerRuntime {
  ws: MempoolWebSocketLike | null;
  subscribed: Set<string>;
  invoicesByAddress: Map<string, BtcInvoiceRecord>;
  reconnectAttempt: number;
  reconnectHandle: unknown | null;
  pollHandle: unknown | null;
  lastWsConnectedAt: number | null;
  lastWsDisconnectedAt: number | null;
  tipHeight: number;
  started: boolean;
  stopping: boolean;
}

export class BtcListener {
  private readonly opts: Required<
    Omit<BtcListenerOptions, "onConfirmed" | "logger" | "setTimeout" | "clearTimeout">
  > & {
    onConfirmed?: BtcListenerOptions["onConfirmed"];
    logger: ListenerLogger;
    setTimeout: (cb: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
  };
  private readonly runtime: ListenerRuntime = {
    ws: null,
    subscribed: new Set(),
    invoicesByAddress: new Map(),
    reconnectAttempt: 0,
    reconnectHandle: null,
    pollHandle: null,
    lastWsConnectedAt: null,
    lastWsDisconnectedAt: null,
    tipHeight: 0,
    started: false,
    stopping: false,
  };

  constructor(options: BtcListenerOptions) {
    if (!options.store) throw new Error("BtcListener: store required");
    if (!options.api) throw new Error("BtcListener: api required");
    if (!options.wsFactory) throw new Error("BtcListener: wsFactory required");
    const noopLogger: ListenerLogger = () => {};
    this.opts = {
      store: options.store,
      api: options.api,
      wsFactory: options.wsFactory,
      wsUrl: options.wsUrl ?? MEMPOOL_DEFAULT_WS_URL,
      reconnectBackoffMs:
        options.reconnectBackoffMs && options.reconnectBackoffMs.length > 0
          ? [...options.reconnectBackoffMs]
          : [...DEFAULT_BACKOFF_MS],
      wsDownCutoverMs: options.wsDownCutoverMs ?? DEFAULT_WS_DOWN_CUTOVER_MS,
      restPollIntervalMs:
        options.restPollIntervalMs ?? DEFAULT_REST_POLL_INTERVAL_MS,
      logger: options.logger ?? noopLogger,
      setTimeout:
        options.setTimeout ??
        ((cb, ms) => globalThis.setTimeout(cb, ms) as unknown),
      clearTimeout:
        options.clearTimeout ??
        ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>)),
      onConfirmed: options.onConfirmed,
    };
  }

  /**
   * Start the listener. Steps, in order:
   *
   *   1. Load every pending BTC invoice into the in-memory routing table.
   *   2. REST-backfill: for each address, look up the current UTXO set. Any
   *      UTXO matching the expected amount becomes a recorded TX (status
   *      will then converge to "confirmed" once the conf threshold is met).
   *   3. Open the WS and subscribe to all pending addresses.
   *
   * Backfill (step 2) is what guarantees we don't miss payments that
   * landed while the listener was down — Validacao §4.
   */
  async start(): Promise<void> {
    if (this.runtime.started) return;
    this.runtime.started = true;
    this.runtime.stopping = false;

    const pending = await this.opts.store.listPendingBtc();
    for (const invoice of pending) {
      this.runtime.invoicesByAddress.set(invoice.receive_address, invoice);
    }
    this.opts.logger("info", "btc_listener: loaded pending invoices", {
      count: pending.length,
    });

    // Backfill must happen before WS subscription so we never produce duplicate
    // "recordIncomingTx" calls (WS would re-deliver the same UTXO as a fresh
    // address-transactions event the first time we subscribe).
    await this.backfillPending();

    this.connect();
  }

  async stop(): Promise<void> {
    this.runtime.stopping = true;
    if (this.runtime.reconnectHandle !== null) {
      this.opts.clearTimeout(this.runtime.reconnectHandle);
      this.runtime.reconnectHandle = null;
    }
    if (this.runtime.pollHandle !== null) {
      this.opts.clearTimeout(this.runtime.pollHandle);
      this.runtime.pollHandle = null;
    }
    if (this.runtime.ws) {
      try {
        this.runtime.ws.close(1000, "listener stop");
      } catch {
        // best-effort
      }
      this.runtime.ws = null;
    }
    this.runtime.started = false;
  }

  /**
   * Re-fetch every pending invoice via mempool.space REST and reconcile
   * against in-DB status. Used on boot AND inside the REST poll fallback
   * when the WS has been down longer than the cutover threshold.
   */
  async backfillPending(): Promise<void> {
    const tipHeight = await this.safeFetchTipHeight();
    if (tipHeight !== null) this.runtime.tipHeight = tipHeight;

    const invoices = Array.from(this.runtime.invoicesByAddress.values());
    for (const invoice of invoices) {
      try {
        const utxos = await this.opts.api.fetchAddressUtxos(invoice.receive_address);
        await this.reconcileFromUtxos(invoice, utxos);
      } catch (err) {
        this.opts.logger("warn", "btc_listener: backfill error", {
          invoiceId: invoice.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async safeFetchTipHeight(): Promise<number | null> {
    try {
      return await this.opts.api.fetchTipHeight();
    } catch (err) {
      this.opts.logger("warn", "btc_listener: tip height fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async reconcileFromUtxos(
    invoice: BtcInvoiceRecord,
    utxos: MempoolUtxo[],
  ): Promise<void> {
    const expectedSats = btcDecimalToSats(invoice.amount_native);
    // Sum UTXO value for this address (single-input matching: if exactly the
    // expected amount lands in one or more outputs of the same TX, we accept).
    const byTx = new Map<string, { sats: bigint; status: MempoolUtxo["status"] }>();
    for (const u of utxos) {
      const cur = byTx.get(u.txid) ?? { sats: 0n, status: u.status };
      cur.sats += BigInt(u.value);
      // Keep the most-confirmed status if a tx reports different
      // confirmation states across its outputs (shouldn't happen, but be safe).
      if (u.status.confirmed) cur.status = u.status;
      byTx.set(u.txid, cur);
    }

    for (const [txid, agg] of byTx) {
      if (agg.sats !== expectedSats) continue;
      const confirmations =
        agg.status.confirmed && agg.status.block_height && this.runtime.tipHeight > 0
          ? Math.max(0, this.runtime.tipHeight - agg.status.block_height + 1)
          : 0;
      await this.applyConfirmation(invoice, txid, confirmations);
    }
  }

  /** Open WS, attach handlers, subscribe to all known addresses. */
  private connect(): void {
    if (this.runtime.stopping) return;
    let ws: MempoolWebSocketLike;
    try {
      ws = this.opts.wsFactory(this.opts.wsUrl);
    } catch (err) {
      this.opts.logger("error", "btc_listener: wsFactory threw", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.scheduleReconnect();
      return;
    }
    this.runtime.ws = ws;

    ws.onopen = () => {
      this.runtime.lastWsConnectedAt = Date.now();
      this.runtime.lastWsDisconnectedAt = null;
      this.runtime.reconnectAttempt = 0;
      // Cancel any REST-poll fallback that may have spun up while we were down.
      if (this.runtime.pollHandle !== null) {
        this.opts.clearTimeout(this.runtime.pollHandle);
        this.runtime.pollHandle = null;
      }
      this.opts.logger("info", "btc_listener: ws connected");
      // Subscribe to block tip events for confirmation bumps.
      this.sendSafely(ws, JSON.stringify({ action: "want", data: ["blocks"] }));
      // Subscribe to each pending address.
      this.runtime.subscribed.clear();
      for (const address of this.runtime.invoicesByAddress.keys()) {
        this.subscribeAddress(address);
      }
    };

    ws.onmessage = (ev) => {
      void this.handleMessage(ev.data);
    };

    ws.onerror = (ev) => {
      this.opts.logger("warn", "btc_listener: ws error", {
        kind: (ev as { type?: string } | null)?.type ?? "unknown",
      });
    };

    ws.onclose = () => {
      this.runtime.ws = null;
      // Only stamp on the FIRST drop in a downtime window — successive
      // immediate drops while we're already reconnecting must not reset
      // the cutover clock, or the REST-poll fallback would never trigger.
      if (this.runtime.lastWsDisconnectedAt === null) {
        this.runtime.lastWsDisconnectedAt = Date.now();
      }
      this.opts.logger("warn", "btc_listener: ws closed", {
        attempt: this.runtime.reconnectAttempt,
      });
      if (!this.runtime.stopping) this.scheduleReconnect();
    };
  }

  private sendSafely(ws: MempoolWebSocketLike, payload: string): void {
    try {
      ws.send(payload);
    } catch (err) {
      this.opts.logger("warn", "btc_listener: ws send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Subscribe to a single address. Public so a future invoice-creation
   * hook (Z45 admin endpoint) can call `listener.watchAddress(addr)` to
   * pick up new invoices without waiting for the next reconnect.
   */
  watchAddress(address: string, invoice?: BtcInvoiceRecord): void {
    if (invoice) {
      this.runtime.invoicesByAddress.set(address, invoice);
    }
    if (this.runtime.ws) this.subscribeAddress(address);
  }

  private subscribeAddress(address: string): void {
    if (!this.runtime.ws) return;
    if (this.runtime.subscribed.has(address)) return;
    this.sendSafely(
      this.runtime.ws,
      JSON.stringify({ "track-address": address }),
    );
    this.runtime.subscribed.add(address);
  }

  private scheduleReconnect(): void {
    if (this.runtime.stopping) return;
    if (this.runtime.reconnectHandle !== null) return;
    const schedule = this.opts.reconnectBackoffMs;
    const idx = Math.min(this.runtime.reconnectAttempt, schedule.length - 1);
    const delayMs = schedule[idx]!;
    this.runtime.reconnectAttempt += 1;
    this.opts.logger("info", "btc_listener: scheduling reconnect", {
      attempt: this.runtime.reconnectAttempt,
      delayMs,
    });
    this.runtime.reconnectHandle = this.opts.setTimeout(() => {
      this.runtime.reconnectHandle = null;
      this.connect();
    }, delayMs);
    // Spin up REST poll fallback if WS has been down long enough.
    this.maybeStartRestPoll();
  }

  private maybeStartRestPoll(): void {
    if (this.runtime.pollHandle !== null) return;
    const downSince = this.runtime.lastWsDisconnectedAt;
    if (downSince === null) return;
    const downMs = Date.now() - downSince;
    if (downMs < this.opts.wsDownCutoverMs) return;
    this.opts.logger("warn", "btc_listener: ws down past cutover, starting REST poll", {
      downMs,
      cutoverMs: this.opts.wsDownCutoverMs,
    });
    const tick = (): void => {
      if (this.runtime.stopping || this.runtime.ws) {
        this.runtime.pollHandle = null;
        return;
      }
      void this.backfillPending().finally(() => {
        if (this.runtime.stopping || this.runtime.ws) {
          this.runtime.pollHandle = null;
          return;
        }
        this.runtime.pollHandle = this.opts.setTimeout(
          tick,
          this.opts.restPollIntervalMs,
        );
      });
    };
    this.runtime.pollHandle = this.opts.setTimeout(
      tick,
      this.opts.restPollIntervalMs,
    );
  }

  private async handleMessage(raw: unknown): Promise<void> {
    let parsed: unknown;
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(String(raw));
    } catch {
      this.opts.logger("warn", "btc_listener: non-JSON ws frame");
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;

    if ("block" in obj && obj.block && typeof obj.block === "object") {
      const block = obj.block as { height?: number };
      if (typeof block.height === "number") {
        this.runtime.tipHeight = block.height;
        await this.handleNewBlock();
      }
      return;
    }

    if ("address-transactions" in obj && Array.isArray(obj["address-transactions"])) {
      for (const tx of obj["address-transactions"]) {
        await this.handleAddressTransaction(tx as MempoolTxDetail);
      }
      return;
    }

    // multi-address-transactions: { "<addr>": { mempool: [Tx], confirmed: [Tx], removed: [Tx] } }
    if ("multi-address-transactions" in obj && obj["multi-address-transactions"]) {
      const groups = obj["multi-address-transactions"] as Record<
        string,
        { mempool?: MempoolTxDetail[]; confirmed?: MempoolTxDetail[]; removed?: MempoolTxDetail[] }
      >;
      for (const buckets of Object.values(groups)) {
        for (const tx of buckets.mempool ?? []) await this.handleAddressTransaction(tx);
        for (const tx of buckets.confirmed ?? []) await this.handleAddressTransaction(tx);
        for (const tx of buckets.removed ?? []) await this.handleRemovedTransaction(tx);
      }
    }
  }

  private async handleAddressTransaction(tx: MempoolTxDetail): Promise<void> {
    if (!tx || !Array.isArray(tx.vout)) return;
    // Determine which tracked address this tx pays.
    const touched = new Set<string>();
    for (const out of tx.vout) {
      if (out.scriptpubkey_address && this.runtime.invoicesByAddress.has(out.scriptpubkey_address)) {
        touched.add(out.scriptpubkey_address);
      }
    }
    for (const address of touched) {
      const invoice = this.runtime.invoicesByAddress.get(address);
      if (!invoice) continue;
      const sats = sumPaymentToAddress(tx, address);
      const expected = btcDecimalToSats(invoice.amount_native);
      if (sats !== expected) {
        this.opts.logger("warn", "btc_listener: tx amount mismatch", {
          invoiceId: invoice.id,
          expectedSats: expected.toString(),
          gotSats: sats.toString(),
          txid: tx.txid,
        });
        continue;
      }
      const confirmations =
        tx.status.confirmed && typeof tx.status.block_height === "number" && this.runtime.tipHeight > 0
          ? Math.max(0, this.runtime.tipHeight - tx.status.block_height + 1)
          : 0;
      await this.applyConfirmation(invoice, tx.txid, confirmations);
    }
  }

  private async handleRemovedTransaction(tx: MempoolTxDetail): Promise<void> {
    // Reorg: a tx we may have already credited was kicked out of the chain.
    if (!tx || !tx.txid) return;
    for (const invoice of this.runtime.invoicesByAddress.values()) {
      if (invoice.tx_hash === tx.txid) {
        this.opts.logger("warn", "btc_listener: tx removed (reorg), reverting invoice", {
          invoiceId: invoice.id,
          txid: tx.txid,
        });
        await this.opts.store.revertToPending({ invoiceId: invoice.id });
        invoice.tx_hash = null;
        invoice.confirmations = 0;
        invoice.status = "pending";
      }
    }
  }

  /**
   * New block tipped — re-check confirmation status for every invoice
   * that already has a tx_hash. This is also where we catch silent reorgs:
   * if `fetchTxDetail` returns `confirmed=false` for a tx we previously
   * confirmed, we revert.
   */
  private async handleNewBlock(): Promise<void> {
    const invoices = Array.from(this.runtime.invoicesByAddress.values()).filter(
      (i) => i.tx_hash !== null,
    );
    for (const invoice of invoices) {
      if (!invoice.tx_hash) continue;
      try {
        const detail = await this.opts.api.fetchTxDetail(invoice.tx_hash);
        if (!detail) {
          // Tx vanished entirely — treat as reorg.
          if (invoice.status === "confirmed" || invoice.confirmations > 0) {
            this.opts.logger("warn", "btc_listener: tx vanished, reverting", {
              invoiceId: invoice.id,
              txid: invoice.tx_hash,
            });
            await this.opts.store.revertToPending({ invoiceId: invoice.id });
            invoice.tx_hash = null;
            invoice.confirmations = 0;
            invoice.status = "pending";
          }
          continue;
        }
        if (!detail.status.confirmed) {
          // Reorg of a previously-confirmed tx, OR mempool tx still pending.
          // Only revert if we had previously confirmed it (status moved past pending).
          if (invoice.status === "confirmed") {
            this.opts.logger("warn", "btc_listener: confirmed tx reorged, reverting", {
              invoiceId: invoice.id,
              txid: invoice.tx_hash,
            });
            await this.opts.store.revertToPending({ invoiceId: invoice.id });
            invoice.tx_hash = null;
            invoice.confirmations = 0;
            invoice.status = "pending";
          }
          continue;
        }
        const confirmations =
          typeof detail.status.block_height === "number" && this.runtime.tipHeight > 0
            ? Math.max(0, this.runtime.tipHeight - detail.status.block_height + 1)
            : invoice.confirmations;
        await this.applyConfirmation(invoice, invoice.tx_hash, confirmations);
      } catch (err) {
        this.opts.logger("warn", "btc_listener: block reconciliation error", {
          invoiceId: invoice.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private async applyConfirmation(
    invoice: BtcInvoiceRecord,
    txHash: string,
    confirmations: number,
  ): Promise<void> {
    const required = invoice.required_confirmations;
    if (invoice.tx_hash === null) {
      await this.opts.store.recordIncomingTx({
        invoiceId: invoice.id,
        txHash,
        confirmations,
      });
      invoice.tx_hash = txHash;
    } else if (invoice.tx_hash !== txHash) {
      // Different tx paying the same address — treat as a replacement only
      // if the old one is gone. Conservative: log + skip; the block-tick
      // path will revert the stale tx on its next poll.
      this.opts.logger("warn", "btc_listener: address received second tx", {
        invoiceId: invoice.id,
        existingTx: invoice.tx_hash,
        incomingTx: txHash,
      });
      return;
    }

    invoice.confirmations = confirmations;

    if (invoice.status !== "confirmed" && confirmations >= required) {
      await this.opts.store.markConfirmed({ invoiceId: invoice.id, confirmations });
      invoice.status = "confirmed";
      if (this.opts.onConfirmed) {
        try {
          await this.opts.onConfirmed(invoice, txHash);
        } catch (err) {
          this.opts.logger("error", "btc_listener: onConfirmed hook threw", {
            invoiceId: invoice.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } else if (invoice.status !== "confirmed") {
      await this.opts.store.bumpConfirmations({
        invoiceId: invoice.id,
        confirmations,
      });
    }
  }

  /** Test-only snapshot of internal routing state. */
  inspect(): {
    subscribed: string[];
    pendingAddresses: string[];
    tipHeight: number;
    reconnectAttempt: number;
    wsConnected: boolean;
    pollActive: boolean;
  } {
    return {
      subscribed: Array.from(this.runtime.subscribed),
      pendingAddresses: Array.from(this.runtime.invoicesByAddress.keys()),
      tipHeight: this.runtime.tipHeight,
      reconnectAttempt: this.runtime.reconnectAttempt,
      wsConnected: this.runtime.ws !== null,
      pollActive: this.runtime.pollHandle !== null,
    };
  }
}

/**
 * Default REST client backed by `fetch`. Mempool.space's REST is plain
 * JSON for all endpoints except `/blocks/tip/height`, which is plain text.
 */
export function createMempoolApiClient(options?: {
  baseUrl?: string;
  fetch?: typeof fetch;
}): MempoolApiClient {
  const baseUrl = options?.baseUrl ?? "https://mempool.space/api";
  const f = options?.fetch ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("createMempoolApiClient: global fetch unavailable; pass options.fetch");
  }
  return {
    async fetchAddressUtxos(addr: string): Promise<MempoolUtxo[]> {
      const res = await f(`${baseUrl}/address/${encodeURIComponent(addr)}/utxo`);
      if (!res.ok) {
        if (res.status === 404) return [];
        throw new Error(`mempool: utxo ${addr} -> ${res.status}`);
      }
      return (await res.json()) as MempoolUtxo[];
    },
    async fetchTxDetail(txid: string): Promise<MempoolTxDetail | null> {
      const res = await f(`${baseUrl}/tx/${encodeURIComponent(txid)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`mempool: tx ${txid} -> ${res.status}`);
      return (await res.json()) as MempoolTxDetail;
    },
    async fetchTipHeight(): Promise<number> {
      const res = await f(`${baseUrl}/blocks/tip/height`);
      if (!res.ok) throw new Error(`mempool: tip height -> ${res.status}`);
      const text = (await res.text()).trim();
      const n = Number.parseInt(text, 10);
      if (!Number.isInteger(n)) {
        throw new Error(`mempool: tip height non-integer "${text}"`);
      }
      return n;
    },
  };
}

/**
 * Default WebSocket factory backed by Node 22's global `WebSocket`. Callers
 * on older runtimes should pass their own factory wired to the `ws` package.
 */
export function createDefaultWebSocketFactory(): WebSocketFactory {
  const GlobalWS = (globalThis as { WebSocket?: new (url: string) => unknown }).WebSocket;
  if (typeof GlobalWS !== "function") {
    throw new Error(
      "createDefaultWebSocketFactory: global WebSocket unavailable on this runtime; " +
        "pass a wsFactory backed by the `ws` package",
    );
  }
  return (url) => new (GlobalWS as new (url: string) => MempoolWebSocketLike)(url);
}
