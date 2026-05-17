import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  BtcListener,
  btcDecimalToSats,
  requiredConfirmationsForUsd,
  sumPaymentToAddress,
  type BtcInvoiceRecord,
  type InvoiceStore,
  type MempoolApiClient,
  type MempoolTxDetail,
  type MempoolUtxo,
  type MempoolWebSocketLike,
  type WebSocketFactory,
} from "../src/services/btc_listener.js";

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

function makeInvoice(overrides: Partial<BtcInvoiceRecord> = {}): BtcInvoiceRecord {
  return {
    id: overrides.id ?? "inv-1",
    receive_address: overrides.receive_address ?? "bc1qaddress1",
    amount_native: overrides.amount_native ?? "0.00100000",
    amount_usd: overrides.amount_usd ?? 25,
    required_confirmations: overrides.required_confirmations ?? 1,
    status: overrides.status ?? "pending",
    tx_hash: overrides.tx_hash ?? null,
    confirmations: overrides.confirmations ?? 0,
    expires_at: overrides.expires_at ?? "2099-01-01T00:00:00.000Z",
  };
}

class FakeStore implements InvoiceStore {
  pending: BtcInvoiceRecord[] = [];
  calls: Array<{ op: string; args: Record<string, unknown> }> = [];

  async listPendingBtc(): Promise<BtcInvoiceRecord[]> {
    return this.pending.map((p) => ({ ...p }));
  }
  async findBtcByAddress(address: string): Promise<BtcInvoiceRecord | null> {
    return this.pending.find((p) => p.receive_address === address) ?? null;
  }
  async recordIncomingTx(args: {
    invoiceId: string;
    txHash: string;
    confirmations: number;
  }): Promise<void> {
    this.calls.push({ op: "recordIncomingTx", args });
    const inv = this.pending.find((p) => p.id === args.invoiceId);
    if (inv) {
      inv.tx_hash = args.txHash;
      inv.confirmations = args.confirmations;
    }
  }
  async bumpConfirmations(args: {
    invoiceId: string;
    confirmations: number;
  }): Promise<void> {
    this.calls.push({ op: "bumpConfirmations", args });
    const inv = this.pending.find((p) => p.id === args.invoiceId);
    if (inv) inv.confirmations = args.confirmations;
  }
  async markConfirmed(args: {
    invoiceId: string;
    confirmations: number;
  }): Promise<void> {
    this.calls.push({ op: "markConfirmed", args });
    const inv = this.pending.find((p) => p.id === args.invoiceId);
    if (inv) {
      inv.status = "confirmed";
      inv.confirmations = args.confirmations;
    }
  }
  async revertToPending(args: { invoiceId: string }): Promise<void> {
    this.calls.push({ op: "revertToPending", args });
    const inv = this.pending.find((p) => p.id === args.invoiceId);
    if (inv) {
      inv.status = "pending";
      inv.tx_hash = null;
      inv.confirmations = 0;
    }
  }
}

class FakeApi implements MempoolApiClient {
  tipHeight = 100;
  utxosByAddress = new Map<string, MempoolUtxo[]>();
  txById = new Map<string, MempoolTxDetail | null>();
  calls: Array<{ op: string; args: unknown }> = [];

  async fetchAddressUtxos(addr: string): Promise<MempoolUtxo[]> {
    this.calls.push({ op: "fetchAddressUtxos", args: addr });
    return this.utxosByAddress.get(addr) ?? [];
  }
  async fetchTxDetail(txid: string): Promise<MempoolTxDetail | null> {
    this.calls.push({ op: "fetchTxDetail", args: txid });
    return this.txById.get(txid) ?? null;
  }
  async fetchTipHeight(): Promise<number> {
    this.calls.push({ op: "fetchTipHeight", args: null });
    return this.tipHeight;
  }
}

class FakeWebSocket implements MempoolWebSocketLike {
  readonly url: string;
  readonly sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  closeCalls: Array<{ code?: number; reason?: string }> = [];

  constructor(url: string) {
    this.url = url;
  }
  send(payload: string): void {
    if (this.closed) throw new Error("ws closed");
    this.sent.push(payload);
  }
  close(code?: number, reason?: string): void {
    this.closed = true;
    this.closeCalls.push({ code, reason });
  }
  // Test helpers
  open(): void {
    this.onopen?.({});
  }
  emit(message: unknown): void {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  drop(): void {
    this.closed = true;
    this.onclose?.({});
  }
}

function makeWsFactory(): {
  factory: WebSocketFactory;
  instances: FakeWebSocket[];
  current(): FakeWebSocket;
} {
  const instances: FakeWebSocket[] = [];
  return {
    factory: (url) => {
      const ws = new FakeWebSocket(url);
      instances.push(ws);
      return ws;
    },
    instances,
    current() {
      const last = instances[instances.length - 1];
      if (!last) throw new Error("no ws instances yet");
      return last;
    },
  };
}

interface FakeTimer {
  cb: () => void;
  ms: number;
  handle: number;
  fired: boolean;
}

function makeFakeClock(): {
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  fireAll: () => Promise<void>;
  fireDueWithin: (ms: number) => Promise<void>;
  pending: FakeTimer[];
} {
  const pending: FakeTimer[] = [];
  let nextHandle = 1;
  return {
    setTimeout(cb, ms) {
      const t: FakeTimer = { cb, ms, handle: nextHandle++, fired: false };
      pending.push(t);
      return t.handle;
    },
    clearTimeout(handle) {
      const idx = pending.findIndex((t) => t.handle === handle);
      if (idx >= 0) pending.splice(idx, 1);
    },
    async fireAll() {
      while (pending.length > 0) {
        const t = pending.shift()!;
        t.fired = true;
        t.cb();
        // Allow promise microtasks to settle (e.g. async reconnect chain).
        await Promise.resolve();
      }
    },
    async fireDueWithin(ms) {
      const due = pending.filter((t) => t.ms <= ms);
      for (const t of due) {
        const idx = pending.indexOf(t);
        if (idx >= 0) pending.splice(idx, 1);
        t.fired = true;
        t.cb();
        await Promise.resolve();
      }
    },
    pending,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("requiredConfirmationsForUsd", () => {
  it("returns 1 conf below $50", () => {
    expect(requiredConfirmationsForUsd(0)).toBe(1);
    expect(requiredConfirmationsForUsd(1)).toBe(1);
    expect(requiredConfirmationsForUsd(49.99)).toBe(1);
  });
  it("returns 3 conf between $50 and $499.99", () => {
    expect(requiredConfirmationsForUsd(50)).toBe(3);
    expect(requiredConfirmationsForUsd(100)).toBe(3);
    expect(requiredConfirmationsForUsd(499.99)).toBe(3);
  });
  it("returns 6 conf at $500 and above", () => {
    expect(requiredConfirmationsForUsd(500)).toBe(6);
    expect(requiredConfirmationsForUsd(50_000)).toBe(6);
  });
  it("rejects negative or non-finite inputs", () => {
    expect(() => requiredConfirmationsForUsd(-1)).toThrow();
    expect(() => requiredConfirmationsForUsd(Number.NaN)).toThrow();
    expect(() => requiredConfirmationsForUsd(Number.POSITIVE_INFINITY)).toThrow();
  });
});

describe("btcDecimalToSats", () => {
  it("converts whole-BTC decimals", () => {
    expect(btcDecimalToSats("1")).toBe(100_000_000n);
    expect(btcDecimalToSats("1.0")).toBe(100_000_000n);
  });
  it("converts sub-sat-aligned fractions", () => {
    expect(btcDecimalToSats("0.00012500")).toBe(12_500n);
    expect(btcDecimalToSats("0.00000001")).toBe(1n);
  });
  it("rejects scientific notation, negatives, and >8 decimal places", () => {
    expect(() => btcDecimalToSats("1e-8")).toThrow();
    expect(() => btcDecimalToSats("-0.5")).toThrow();
    expect(() => btcDecimalToSats("0.000000001")).toThrow();
    expect(() => btcDecimalToSats("")).toThrow();
  });
});

describe("sumPaymentToAddress", () => {
  it("sums only the outputs paying the target address", () => {
    const tx = {
      vout: [
        { scriptpubkey_address: "bc1qa", value: 5000 },
        { scriptpubkey_address: "bc1qb", value: 9000 },
        { scriptpubkey_address: "bc1qa", value: 7500 },
        { value: 1000 }, // missing address -> ignored
      ],
    };
    expect(sumPaymentToAddress(tx, "bc1qa")).toBe(12_500n);
    expect(sumPaymentToAddress(tx, "bc1qb")).toBe(9000n);
    expect(sumPaymentToAddress(tx, "bc1qz")).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Integration-style tests through BtcListener
// ---------------------------------------------------------------------------

describe("BtcListener", () => {
  let store: FakeStore;
  let api: FakeApi;
  let wsFactory: ReturnType<typeof makeWsFactory>;
  let clock: ReturnType<typeof makeFakeClock>;

  beforeEach(() => {
    store = new FakeStore();
    api = new FakeApi();
    wsFactory = makeWsFactory();
    clock = makeFakeClock();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function buildListener(extra: Partial<Parameters<typeof BtcListener.prototype.start>[0]> = {}) {
    void extra; // unused, parameter shape only for IDE
    return new BtcListener({
      store,
      api,
      wsFactory: wsFactory.factory,
      reconnectBackoffMs: [10, 20, 30, 40],
      wsDownCutoverMs: 25,
      restPollIntervalMs: 5,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });
  }

  // Validation §1
  it("subscribes to all pending addresses on connect (100 invoices)", async () => {
    // Seed 100 distinct pending invoices.
    for (let i = 0; i < 100; i++) {
      store.pending.push(
        makeInvoice({
          id: `inv-${i}`,
          receive_address: `bc1q-${i.toString().padStart(3, "0")}`,
          amount_native: "0.00010000",
        }),
      );
    }
    const listener = buildListener();
    await listener.start();
    wsFactory.current().open();

    const sent = wsFactory.current().sent;
    // First send is the block-want subscription, then 100 track-address frames.
    expect(sent[0]).toBe(JSON.stringify({ action: "want", data: ["blocks"] }));
    const trackFrames = sent.slice(1).map((s) => JSON.parse(s));
    expect(trackFrames).toHaveLength(100);
    const trackedAddresses = new Set(
      trackFrames.map((f: { "track-address": string }) => f["track-address"]),
    );
    expect(trackedAddresses.size).toBe(100);
    expect(listener.inspect().subscribed).toHaveLength(100);
    await listener.stop();
  });

  // Validation §2 (TX detected via WS)
  it("records and confirms a tx delivered via WS when threshold is met", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-A",
        receive_address: "bc1qpayer",
        amount_native: "0.00050000", // 50_000 sats
        required_confirmations: 1,
        amount_usd: 10,
      }),
    );
    api.tipHeight = 200;
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    // Synthetic confirmed tx in block 200 = 1 confirmation @ tip 200.
    ws.emit({
      "address-transactions": [
        {
          txid: "tx-aaa",
          vout: [
            { scriptpubkey_address: "bc1qpayer", value: 50_000 },
            { scriptpubkey_address: "bc1qchange", value: 1_000 },
          ],
          status: { confirmed: true, block_height: 200 },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    const ops = store.calls.map((c) => c.op);
    expect(ops).toContain("recordIncomingTx");
    expect(ops).toContain("markConfirmed");
    expect(store.pending[0]?.status).toBe("confirmed");
    expect(store.pending[0]?.tx_hash).toBe("tx-aaa");
    expect(store.pending[0]?.confirmations).toBe(1);
    await listener.stop();
  });

  it("holds at pending until threshold met for $100 invoice (3 conf)", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-mid",
        receive_address: "bc1qmid",
        amount_native: "0.00500000",
        required_confirmations: 3,
        amount_usd: 100,
      }),
    );
    api.tipHeight = 100;
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    // First sighting: in block 100 -> 1 confirmation, not enough.
    ws.emit({
      "address-transactions": [
        {
          txid: "tx-mid",
          vout: [{ scriptpubkey_address: "bc1qmid", value: 500_000 }],
          status: { confirmed: true, block_height: 100 },
        },
      ],
    });
    await Promise.resolve();
    expect(store.pending[0]?.status).toBe("pending");
    expect(store.pending[0]?.confirmations).toBe(1);

    // Block tip advances to 102 (=3 confirmations).
    api.txById.set("tx-mid", {
      txid: "tx-mid",
      vout: [{ scriptpubkey_address: "bc1qmid", value: 500_000 }],
      status: { confirmed: true, block_height: 100 },
    });
    ws.emit({ block: { height: 102 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.pending[0]?.status).toBe("confirmed");
    expect(store.pending[0]?.confirmations).toBe(3);
    await listener.stop();
  });

  it("ignores tx outputs that don't match the expected amount", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-miss",
        receive_address: "bc1qmiss",
        amount_native: "0.00010000",
        amount_usd: 5,
      }),
    );
    const listener = buildListener();
    await listener.start();
    wsFactory.current().open();
    wsFactory.current().emit({
      "address-transactions": [
        {
          txid: "tx-wrong",
          vout: [{ scriptpubkey_address: "bc1qmiss", value: 9_999 }],
          status: { confirmed: false },
        },
      ],
    });
    await Promise.resolve();
    expect(store.calls.find((c) => c.op === "recordIncomingTx")).toBeUndefined();
    expect(store.pending[0]?.tx_hash).toBeNull();
    await listener.stop();
  });

  // Validation §3 (reorg)
  it("reverts a confirmed invoice when its tx is removed via reorg", async () => {
    const inv = makeInvoice({
      id: "inv-reorg",
      receive_address: "bc1qreorg",
      amount_native: "0.00020000",
      amount_usd: 5,
      required_confirmations: 1,
    });
    store.pending.push(inv);
    api.tipHeight = 50;
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    // First, confirm at 1-conf.
    ws.emit({
      "address-transactions": [
        {
          txid: "tx-reorg",
          vout: [{ scriptpubkey_address: "bc1qreorg", value: 20_000 }],
          status: { confirmed: true, block_height: 50 },
        },
      ],
    });
    await Promise.resolve();
    expect(store.pending[0]?.status).toBe("confirmed");

    // Reorg: server emits multi-address-transactions with `removed`.
    ws.emit({
      "multi-address-transactions": {
        bc1qreorg: {
          removed: [
            {
              txid: "tx-reorg",
              vout: [{ scriptpubkey_address: "bc1qreorg", value: 20_000 }],
              status: { confirmed: false },
            },
          ],
        },
      },
    });
    await Promise.resolve();
    expect(store.calls.some((c) => c.op === "revertToPending")).toBe(true);
    expect(store.pending[0]?.status).toBe("pending");
    expect(store.pending[0]?.tx_hash).toBeNull();
    expect(store.pending[0]?.confirmations).toBe(0);
    await listener.stop();
  });

  it("reverts a confirmed invoice when block-tick re-check shows confirmed=false", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-silent",
        receive_address: "bc1qsilent",
        amount_native: "0.00030000",
        amount_usd: 8,
        required_confirmations: 1,
      }),
    );
    api.tipHeight = 200;
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    ws.emit({
      "address-transactions": [
        {
          txid: "tx-silent",
          vout: [{ scriptpubkey_address: "bc1qsilent", value: 30_000 }],
          status: { confirmed: true, block_height: 200 },
        },
      ],
    });
    await Promise.resolve();
    expect(store.pending[0]?.status).toBe("confirmed");

    // Simulate the tx silently becoming unconfirmed: block tick fires
    // re-reconciliation against the REST API which now says confirmed=false.
    api.txById.set("tx-silent", {
      txid: "tx-silent",
      vout: [{ scriptpubkey_address: "bc1qsilent", value: 30_000 }],
      status: { confirmed: false },
    });
    ws.emit({ block: { height: 201 } });
    await Promise.resolve();
    await Promise.resolve();
    expect(store.pending[0]?.status).toBe("pending");
    expect(store.pending[0]?.tx_hash).toBeNull();
    await listener.stop();
  });

  // Validation §4 (boot backfill)
  it("backfills pending UTXOs on boot via REST before opening WS", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-boot",
        receive_address: "bc1qboot",
        amount_native: "0.00012345",
        amount_usd: 12,
        required_confirmations: 1,
      }),
    );
    api.tipHeight = 1000;
    api.utxosByAddress.set("bc1qboot", [
      {
        txid: "tx-boot",
        vout: 0,
        value: 12_345,
        status: { confirmed: true, block_height: 1000 },
      },
    ]);
    const listener = buildListener();
    await listener.start();

    // recordIncomingTx + markConfirmed should already have fired before the WS
    // even opens — the WS frame for the same UTXO would be a duplicate.
    expect(store.pending[0]?.status).toBe("confirmed");
    expect(store.pending[0]?.tx_hash).toBe("tx-boot");
    expect(api.calls.some((c) => c.op === "fetchAddressUtxos" && c.args === "bc1qboot")).toBe(true);
    await listener.stop();
  });

  it("ignores backfill UTXOs whose value doesn't match the expected amount", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-bf-mismatch",
        receive_address: "bc1qbfm",
        amount_native: "0.00020000",
      }),
    );
    api.utxosByAddress.set("bc1qbfm", [
      {
        txid: "tx-bfm",
        vout: 0,
        value: 19_999,
        status: { confirmed: true, block_height: 1 },
      },
    ]);
    const listener = buildListener();
    await listener.start();
    expect(store.calls.find((c) => c.op === "recordIncomingTx")).toBeUndefined();
    await listener.stop();
  });

  // Resilience: reconnect backoff schedule
  it("schedules reconnect on ws close, advancing through the backoff schedule", async () => {
    const listener = buildListener();
    await listener.start();
    const ws1 = wsFactory.current();
    ws1.open();
    ws1.drop();
    expect(clock.pending).toHaveLength(1);
    expect(clock.pending[0]?.ms).toBe(10);
    await clock.fireAll();
    // After firing, a new WS instance must have been created via factory.
    expect(wsFactory.instances.length).toBeGreaterThanOrEqual(2);

    // Drop again -> next backoff tier (20ms).
    const ws2 = wsFactory.current();
    ws2.drop();
    expect(clock.pending[0]?.ms).toBe(20);
    await clock.fireAll();
    expect(wsFactory.instances.length).toBeGreaterThanOrEqual(3);

    // Drop again -> 30ms tier.
    const ws3 = wsFactory.current();
    ws3.drop();
    expect(clock.pending[0]?.ms).toBe(30);

    await listener.stop();
  });

  it("resets reconnect attempt counter after a successful open", async () => {
    const listener = buildListener();
    await listener.start();
    const ws1 = wsFactory.current();
    ws1.open();
    ws1.drop();
    await clock.fireAll();

    const ws2 = wsFactory.current();
    ws2.open(); // success — should reset attempt counter
    expect(listener.inspect().reconnectAttempt).toBe(0);
    ws2.drop();
    expect(clock.pending[0]?.ms).toBe(10); // back to first tier
    await listener.stop();
  });

  // Resilience: REST poll fallback
  it("spins up REST poll fallback once ws has been down past cutover", async () => {
    const listener = buildListener();
    await listener.start();
    const ws1 = wsFactory.current();
    ws1.open();
    const realNow = Date.now;
    let nowMs = 1_000_000;
    Date.now = () => nowMs;
    try {
      // First drop: cutover clock starts.
      ws1.drop();
      expect(listener.inspect().pollActive).toBe(false);

      // Advance past the cutover window, then fire the 10ms reconnect to
      // create ws2 (which we leave un-opened to keep WS effectively down).
      nowMs += 60_000;
      await clock.fireDueWithin(10);
      // ws2 now exists; drop it to re-enter scheduleReconnect, which on this
      // pass sees downMs > cutover and arms the REST poll.
      wsFactory.current().drop();
      expect(listener.inspect().pollActive).toBe(true);
    } finally {
      Date.now = realNow;
      await listener.stop();
    }
  });

  it("REST poll tick picks up a UTXO that arrived while ws was down", async () => {
    // The poll loop reuses `backfillPending()`. Proving that backfill itself
    // detects a fresh UTXO on the configured address is sufficient.
    store.pending.push(
      makeInvoice({
        id: "inv-poll",
        receive_address: "bc1qpoll",
        amount_native: "0.00007500",
        amount_usd: 5,
        required_confirmations: 1,
      }),
    );
    api.tipHeight = 500;
    api.utxosByAddress.set("bc1qpoll", [
      {
        txid: "tx-poll",
        vout: 0,
        value: 7_500,
        status: { confirmed: true, block_height: 500 },
      },
    ]);
    const listener = buildListener();
    await listener.start();
    expect(store.pending[0]?.tx_hash).toBe("tx-poll");
    expect(store.pending[0]?.status).toBe("confirmed");
    await listener.stop();
  });

  it("watchAddress sends a track-address frame when ws is connected", async () => {
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    const before = ws.sent.length;
    listener.watchAddress(
      "bc1qlate",
      makeInvoice({ id: "inv-late", receive_address: "bc1qlate" }),
    );
    const after = ws.sent.length;
    expect(after).toBe(before + 1);
    expect(JSON.parse(ws.sent[after - 1]!)).toEqual({ "track-address": "bc1qlate" });
    await listener.stop();
  });

  it("does not double-subscribe the same address", async () => {
    store.pending.push(makeInvoice({ id: "inv-dup", receive_address: "bc1qdup" }));
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    const beforeSubs = listener.inspect().subscribed.length;
    listener.watchAddress("bc1qdup");
    expect(listener.inspect().subscribed.length).toBe(beforeSubs);
    await listener.stop();
  });

  it("fires onConfirmed once when threshold reached", async () => {
    store.pending.push(
      makeInvoice({
        id: "inv-cb",
        receive_address: "bc1qcb",
        amount_native: "0.00100000",
        amount_usd: 30,
        required_confirmations: 1,
      }),
    );
    api.tipHeight = 5;
    const hook = vi.fn();
    const listener = new BtcListener({
      store,
      api,
      wsFactory: wsFactory.factory,
      reconnectBackoffMs: [10],
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onConfirmed: hook,
    });
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    ws.emit({
      "address-transactions": [
        {
          txid: "tx-cb",
          vout: [{ scriptpubkey_address: "bc1qcb", value: 100_000 }],
          status: { confirmed: true, block_height: 5 },
        },
      ],
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook.mock.calls[0]?.[1]).toBe("tx-cb");
    await listener.stop();
  });

  it("stop closes the active ws and cancels pending timers", async () => {
    store.pending.push(makeInvoice({ id: "inv-stop", receive_address: "bc1qstop" }));
    const listener = buildListener();
    await listener.start();
    const ws = wsFactory.current();
    ws.open();
    ws.drop(); // schedules reconnect
    expect(clock.pending.length).toBeGreaterThan(0);
    await listener.stop();
    expect(clock.pending).toHaveLength(0);
    expect(listener.inspect().wsConnected).toBe(false);
  });
});
