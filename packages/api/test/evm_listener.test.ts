// Z47 — Unit tests for `EvmListener`. The viem `PublicClient` is stubbed
// via the `ListenerPublicClient` seam so the tests run offline. The store
// is an in-memory implementation that mirrors Z45's
// `public.zettapay_invoices` semantics (markMatched, updateConfirmations,
// markConfirmed).

import { describe, it, expect, vi } from "vitest";
import type {
  EvmListenerChain,
  InvoiceStore,
  ListenerPublicClient,
  MatchedTx,
  PendingInvoice,
} from "../src/services/evm_listener.js";
import {
  EvmListener,
  POLYGON_FINALITY_BLOCKS,
  USDC_BASE_SEPOLIA,
  USDC_POLYGON_AMOY,
  USDC_POLYGON_MAINNET,
} from "../src/services/evm_listener.js";

type TransferLog = {
  args: { from: `0x${string}`; to: `0x${string}`; value: bigint };
  transactionHash: `0x${string}`;
  blockNumber: bigint;
};

interface RecordedState {
  matched: Array<{ id: string; tx: MatchedTx }>;
  confirmations: Array<{ id: string; count: number }>;
  confirmedAt: Array<{ id: string; at: Date }>;
}

function makeStore(pending: PendingInvoice[]): {
  store: InvoiceStore;
  state: RecordedState;
} {
  const state: RecordedState = {
    matched: [],
    confirmations: [],
    confirmedAt: [],
  };
  const store: InvoiceStore = {
    listPending: async (_chain: EvmListenerChain) => pending,
    markMatched: async (id, tx) => {
      state.matched.push({ id, tx });
    },
    updateConfirmations: async (id, count) => {
      state.confirmations.push({ id, count });
    },
    markConfirmed: async (id, at) => {
      state.confirmedAt.push({ id, at });
    },
  };
  return { store, state };
}

interface StubClientOptions {
  head?: bigint;
  pastLogs?: TransferLog[];
  receiptStatus?: "success" | "reverted";
  receiptDelayMs?: number;
}

function makeStubClient(opts: StubClientOptions = {}): {
  client: ListenerPublicClient;
  emitLogs: (logs: TransferLog[]) => void;
  triggerError: (err: Error) => void;
  subscribeCount: () => number;
  getArgsHistory: () => Array<readonly `0x${string}`[] | undefined>;
} {
  let subscribers: Array<{
    onLogs: (logs: TransferLog[]) => void;
    onError?: (err: Error) => void;
  }> = [];
  let subscribeCalls = 0;
  const argsHistory: Array<readonly `0x${string}`[] | undefined> = [];
  const client: ListenerPublicClient = {
    getBlockNumber: vi.fn(async () => opts.head ?? 1_000n),
    getLogs: vi.fn(async () => (opts.pastLogs ?? []) as never),
    watchContractEvent: vi.fn(({ args, onLogs, onError }) => {
      subscribeCalls += 1;
      argsHistory.push(args?.to);
      const sub = { onLogs: onLogs as (logs: TransferLog[]) => void, onError };
      subscribers.push(sub);
      return () => {
        subscribers = subscribers.filter((s) => s !== sub);
      };
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      if (opts.receiptDelayMs && opts.receiptDelayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.receiptDelayMs));
      }
      return {
        status: opts.receiptStatus ?? ("success" as const),
        blockNumber: (opts.head ?? 1_000n) + 1n,
      };
    }),
  };
  return {
    client,
    emitLogs: (logs) => {
      for (const sub of subscribers) sub.onLogs(logs);
    },
    triggerError: (err) => {
      for (const sub of subscribers) sub.onError?.(err);
    },
    subscribeCount: () => subscribeCalls,
    getArgsHistory: () => argsHistory,
  };
}

const INVOICE_A: PendingInvoice = {
  id: "inv-a",
  chain: "base-sepolia",
  receiveAddress: "0xAAaAaaAaAaAAAAaAaaAAaAaAaaaaaAaaAaaaAaAa",
  amountNative: 12_500_000n, // 12.50 USDC atomic
  requiredConfirmations: 12,
};

const INVOICE_B: PendingInvoice = {
  id: "inv-b",
  chain: "base-sepolia",
  receiveAddress: "0xBBbBbbBbBBBBBBbBbbBBbBbBbbbbbBbbBbbbBbBb",
  amountNative: 3_000_000n,
  requiredConfirmations: 12,
};

const TX_HASH_1 =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const TX_HASH_2 =
  "0x2222222222222222222222222222222222222222222222222222222222222222" as const;

describe("EvmListener — happy path", () => {
  it("matches a Transfer on Base USDC by (to, value)", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const { client, emitLogs } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    expect(listener.getActiveInvoiceCount()).toBe(1);

    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: INVOICE_A.receiveAddress,
          value: INVOICE_A.amountNative,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);

    // Drain promise queue created inside the onLogs handler.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(state.matched).toHaveLength(1);
    expect(state.matched[0]?.id).toBe("inv-a");
    expect(state.matched[0]?.tx.hash).toBe(TX_HASH_1);
    expect(listener.hasMatched("inv-a")).toBe(true);
    listener.stop();
  });

  it("ignores Transfers with the right `to` but wrong `value`", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const { client, emitLogs } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();

    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: INVOICE_A.receiveAddress,
          value: INVOICE_A.amountNative - 1n,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);
    await new Promise((r) => setImmediate(r));

    expect(state.matched).toHaveLength(0);
    expect(listener.hasMatched("inv-a")).toBe(false);
    listener.stop();
  });

  it("matches addresses case-insensitively (EIP-55 vs lowercase)", async () => {
    const { store, state } = makeStore([
      {
        ...INVOICE_A,
        receiveAddress: INVOICE_A.receiveAddress.toLowerCase() as `0x${string}`,
      },
    ]);
    const { client, emitLogs } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: INVOICE_A.receiveAddress, // EIP-55 mixed case
          value: INVOICE_A.amountNative,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);
    await new Promise((r) => setImmediate(r));
    expect(state.matched).toHaveLength(1);
    listener.stop();
  });

  it("dedupes repeated Transfer logs for the same invoice", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const { client, emitLogs } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    const log: TransferLog = {
      args: {
        from: "0xPAYER000000000000000000000000000000Payer",
        to: INVOICE_A.receiveAddress,
        value: INVOICE_A.amountNative,
      },
      transactionHash: TX_HASH_1,
      blockNumber: 1_001n,
    };
    emitLogs([log]);
    emitLogs([log]);
    await new Promise((r) => setImmediate(r));
    expect(state.matched).toHaveLength(1);
    listener.stop();
  });
});

describe("EvmListener — backfill + dynamic filter", () => {
  it("backfills past Transfers via getLogs on boot", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const pastLog: TransferLog = {
      args: {
        from: "0xPAYER000000000000000000000000000000Payer",
        to: INVOICE_A.receiveAddress,
        value: INVOICE_A.amountNative,
      },
      transactionHash: TX_HASH_2,
      blockNumber: 950n,
    };
    const { client } = makeStubClient({
      head: 1_000n,
      pastLogs: [pastLog],
    });
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    await new Promise((r) => setImmediate(r));
    expect(state.matched).toHaveLength(1);
    expect(state.matched[0]?.tx.hash).toBe(TX_HASH_2);
    // getLogs was called with the right `address` + Transfer event.
    expect(client.getLogs).toHaveBeenCalled();
    listener.stop();
  });

  it("requestRefresh debounces + re-subscribes with new addresses", async () => {
    vi.useFakeTimers();
    let pending: PendingInvoice[] = [INVOICE_A];
    const state: RecordedState = {
      matched: [],
      confirmations: [],
      confirmedAt: [],
    };
    const store: InvoiceStore = {
      listPending: async () => pending,
      markMatched: async (id, tx) => {
        state.matched.push({ id, tx });
      },
      updateConfirmations: async (id, count) => {
        state.confirmations.push({ id, count });
      },
      markConfirmed: async (id, at) => {
        state.confirmedAt.push({ id, at });
      },
    };
    const { client, getArgsHistory, subscribeCount } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
      refreshDebounceMs: 2_000,
    });
    await listener.start();
    expect(subscribeCount()).toBe(1);
    expect(getArgsHistory()[0]).toEqual([INVOICE_A.receiveAddress]);

    // Add invoice B and fire two close-together refresh requests — they
    // must coalesce into a single re-subscription after the debounce.
    pending = [INVOICE_A, INVOICE_B];
    listener.requestRefresh();
    listener.requestRefresh();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(subscribeCount()).toBe(1); // debounce still pending
    await vi.advanceTimersByTimeAsync(10);
    // give the async refresh chain a chance to flush
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(subscribeCount()).toBe(2);
    const last = getArgsHistory()[1];
    expect(last).toContain(INVOICE_A.receiveAddress);
    expect(last).toContain(INVOICE_B.receiveAddress);
    listener.stop();
    vi.useRealTimers();
  });
});

describe("EvmListener — confirmation policy", () => {
  it("promotes the invoice to confirmed after waitForTransactionReceipt resolves", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const { client, emitLogs } = makeStubClient({ receiptStatus: "success" });
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: INVOICE_A.receiveAddress,
          value: INVOICE_A.amountNative,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);
    // Allow background trackConfirmations promise chain to flush.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(state.matched).toHaveLength(1);
    expect(state.confirmedAt).toHaveLength(1);
    expect(state.confirmedAt[0]?.id).toBe("inv-a");
    expect(client.waitForTransactionReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        hash: TX_HASH_1,
        confirmations: 12,
      }),
    );
    listener.stop();
  });

  it("does NOT promote the invoice when the tx reverts", async () => {
    const { store, state } = makeStore([INVOICE_A]);
    const { client, emitLogs } = makeStubClient({ receiptStatus: "reverted" });
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: INVOICE_A.receiveAddress,
          value: INVOICE_A.amountNative,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(state.matched).toHaveLength(1);
    expect(state.confirmedAt).toHaveLength(0);
    listener.stop();
  });
});

describe("EvmListener — resilience", () => {
  it("self-reconnects after watchContractEvent reports an error", async () => {
    vi.useFakeTimers();
    const { store } = makeStore([INVOICE_A]);
    const { client, triggerError, subscribeCount } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
      reconnectDelayMs: 1_000,
    });
    await listener.start();
    expect(subscribeCount()).toBe(1);
    triggerError(new Error("websocket dropped"));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(subscribeCount()).toBeGreaterThan(1);
    listener.stop();
    vi.useRealTimers();
  });

  it("stop() prevents further reconnect attempts", async () => {
    vi.useFakeTimers();
    const { store } = makeStore([INVOICE_A]);
    const { client, triggerError, subscribeCount } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
      reconnectDelayMs: 500,
    });
    await listener.start();
    listener.stop();
    triggerError(new Error("dropped after stop"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(subscribeCount()).toBe(1);
    vi.useRealTimers();
  });
});

describe("EvmListener — defaults", () => {
  it("defaults to Base Sepolia USDC when contractAddress is omitted", async () => {
    const { store } = makeStore([INVOICE_A]);
    const { client } = makeStubClient();
    const listener = new EvmListener({
      chain: "base-sepolia",
      store,
      publicClient: client,
    });
    await listener.start();
    const subscribeArgs = (client.watchContractEvent as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(subscribeArgs?.address).toBe(USDC_BASE_SEPOLIA);
    listener.stop();
  });
});

// Z47.2 — Polygon PoS support. The class is chain-scoped, so the Polygon
// listener is a second EvmListener instance with chain='polygon'. The store
// is asked for `chain='polygon'` invoices on boot and the default contract
// address resolves to Circle's native USDC on Polygon PoS.
describe("EvmListener — Polygon", () => {
  const POLYGON_INVOICE: PendingInvoice = {
    id: "inv-poly",
    chain: "polygon",
    receiveAddress: "0xCcCcCCccCccccCcccCCCCcCcCccCCcCcCccCCcCc",
    amountNative: 50_000_000n, // 50 USDC atomic
    requiredConfirmations: POLYGON_FINALITY_BLOCKS,
  };

  it("listPending is called with chain='polygon' on boot", async () => {
    const { store } = makeStore([POLYGON_INVOICE]);
    const listPending = vi.spyOn(store, "listPending");
    const { client } = makeStubClient();
    const listener = new EvmListener({
      chain: "polygon",
      store,
      publicClient: client,
    });
    await listener.start();
    expect(listPending).toHaveBeenCalledWith("polygon");
    expect(listener.getActiveInvoiceCount()).toBe(1);
    listener.stop();
  });

  it("defaults to canonical USDC PoS contract when contractAddress is omitted", async () => {
    const { store } = makeStore([POLYGON_INVOICE]);
    const { client } = makeStubClient();
    const listener = new EvmListener({
      chain: "polygon",
      store,
      publicClient: client,
    });
    await listener.start();
    const subscribeArgs = (client.watchContractEvent as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(subscribeArgs?.address).toBe(USDC_POLYGON_MAINNET);
    listener.stop();
  });

  it("defaults to Amoy USDC on the polygon-amoy testnet", async () => {
    const amoyInvoice: PendingInvoice = {
      ...POLYGON_INVOICE,
      chain: "polygon-amoy",
    };
    const { store } = makeStore([amoyInvoice]);
    const { client } = makeStubClient();
    const listener = new EvmListener({
      chain: "polygon-amoy",
      store,
      publicClient: client,
    });
    await listener.start();
    const subscribeArgs = (client.watchContractEvent as ReturnType<typeof vi.fn>)
      .mock.calls[0]?.[0];
    expect(subscribeArgs?.address).toBe(USDC_POLYGON_AMOY);
    listener.stop();
  });

  it("matches a Transfer on Polygon USDC and waits for 128-block finality", async () => {
    const { store, state } = makeStore([POLYGON_INVOICE]);
    const { client, emitLogs } = makeStubClient();
    const listener = new EvmListener({
      chain: "polygon",
      store,
      publicClient: client,
    });
    await listener.start();
    emitLogs([
      {
        args: {
          from: "0xPAYER000000000000000000000000000000Payer",
          to: POLYGON_INVOICE.receiveAddress,
          value: POLYGON_INVOICE.amountNative,
        },
        transactionHash: TX_HASH_1,
        blockNumber: 1_001n,
      },
    ]);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(state.matched).toHaveLength(1);
    expect(state.matched[0]?.id).toBe("inv-poly");
    expect(
      (client.waitForTransactionReceipt as ReturnType<typeof vi.fn>).mock
        .calls[0]?.[0]?.confirmations,
    ).toBe(POLYGON_FINALITY_BLOCKS);
    listener.stop();
  });

  it("resubscribes after a watch error (free-tier RPCs drop frequently)", async () => {
    vi.useFakeTimers();
    const { store } = makeStore([POLYGON_INVOICE]);
    const { client, triggerError, subscribeCount } = makeStubClient();
    const listener = new EvmListener({
      chain: "polygon",
      store,
      publicClient: client,
      reconnectDelayMs: 500,
    });
    await listener.start();
    expect(subscribeCount()).toBe(1);
    triggerError(new Error("eth_subscribe disconnect"));
    await vi.advanceTimersByTimeAsync(500);
    expect(subscribeCount()).toBe(2);
    listener.stop();
    vi.useRealTimers();
  });
});
