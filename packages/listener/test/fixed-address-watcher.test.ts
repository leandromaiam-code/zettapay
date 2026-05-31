// FixedAddressWatcher tests — exercised against an in-memory StorageAdapter and
// a mocked JSON-RPC `fetch` (eth_blockNumber + eth_getLogs). No real network.
//
// Covers the fixed-address USDC mode (Z74) contract:
//   - a Transfer whose value matches a pending invoice → confirmed + webhook
//   - a Transfer that matches no active invoice → payment.orphan, NEVER confirm
//   - a log below minConfirmations stays un-seen and confirms on a later poll
//   - duplicate txHash:logIndex is processed at most once (dedup)
//
// Entirely separate from BtcListener / BaseWatcher; nothing here touches them.

import { describe, expect, it } from 'vitest';
import { FixedAddressWatcher, type FixedChainConfig } from '../src/fixed-address-watcher.js';
import { EVM_CHAIN_REGISTRY } from '../src/fixed-address-watcher.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type {
  Invoice,
  InvoiceStatus,
  ListPendingInvoicesOpts,
  WebhookEvent,
  WebhookEventInput,
} from '../src/types.js';

const FIXED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: over.id ?? 'inv_fixed_1',
    merchant_id: 'm1',
    chain: over.chain ?? 'base',
    asset: 'USDC',
    amount: over.amount ?? '29000042', // 29 USDC + nonce 42
    address: over.address ?? FIXED_ADDRESS,
    child_index: null,
    status: over.status ?? 'pending',
    expires_at: over.expires_at ?? new Date(Date.now() + 3_600_000).toISOString(),
    paid_at: null,
    tx_hash: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

class FakeStorage implements Partial<StorageAdapter> {
  invoices = new Map<string, Invoice>();
  webhooks: WebhookEvent[] = [];

  constructor(seed: Invoice[]) {
    for (const inv of seed) this.invoices.set(inv.id, inv);
  }

  async listPendingInvoices(opts?: ListPendingInvoicesOpts): Promise<Invoice[]> {
    return [...this.invoices.values()].filter(
      (i) => i.status === 'pending' && (!opts?.chain || i.chain === opts.chain),
    );
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }

  async updateInvoiceStatus(
    id: string,
    status: InvoiceStatus,
    patch?: Partial<Invoice>,
  ): Promise<Invoice> {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error('not found');
    const next = { ...inv, status, ...patch, updated_at: new Date().toISOString() };
    this.invoices.set(id, next);
    return next;
  }

  async recordWebhookEvent(evt: WebhookEventInput): Promise<WebhookEvent> {
    const full: WebhookEvent = {
      ...evt,
      attempts: 0,
      delivered_at: null,
      last_status_code: null,
      last_error: null,
    };
    this.webhooks.push(full);
    return full;
  }
}

interface RpcLog {
  transactionHash: string;
  logIndex: string;
  blockNumber: string;
  data: string;
  topics: string[];
}

/** A fetch that answers eth_blockNumber with `latest` and eth_getLogs with `logs`. */
function rpcFetch(latest: bigint, logs: RpcLog[]): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const { method } = JSON.parse(init.body) as { method: string };
    const result =
      method === 'eth_blockNumber' ? '0x' + latest.toString(16) : method === 'eth_getLogs' ? logs : null;
    return {
      ok: true,
      status: 200,
      json: async () => ({ result }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function makeLog(value: bigint, over: Partial<RpcLog> = {}): RpcLog {
  return {
    transactionHash: over.transactionHash ?? '0xabc',
    logIndex: over.logIndex ?? '0x0',
    blockNumber: over.blockNumber ?? '0x64', // 100
    data: '0x' + value.toString(16),
    topics: [
      '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      '0x' + '0'.repeat(64),
      '0x' + FIXED_ADDRESS.slice(2).toLowerCase().padStart(64, '0'),
    ],
    ...over,
  };
}

function baseChain(): FixedChainConfig {
  return { ...EVM_CHAIN_REGISTRY.base!, rpcUrl: 'https://rpc.test' };
}

function ethChain(): FixedChainConfig {
  return { ...EVM_CHAIN_REGISTRY.ethereum!, rpcUrl: 'https://rpc.test' };
}

function makeWatcher(
  storage: FakeStorage,
  chain: FixedChainConfig,
  fetchImpl: typeof fetch,
): FixedAddressWatcher {
  return new FixedAddressWatcher({
    storage: storage as unknown as StorageAdapter,
    merchantId: 'm1',
    address: FIXED_ADDRESS,
    chains: [chain],
    pollIntervalMs: 999_999,
    fetchImpl,
  });
}

describe('FixedAddressWatcher.pollOnce', () => {
  it('confirms the invoice when a Transfer matches its exact value', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseChain(),
      rpcFetch(100n, [makeLog(29_000042n)]),
    );
    await watcher.pollOnce();

    const inv = storage.invoices.get('inv_fixed_1');
    expect(inv?.status).toBe('confirmed');
    expect(inv?.tx_hash).toBe('0xabc');
    expect(inv?.paid_at).toBeTruthy();

    expect(storage.webhooks).toHaveLength(1);
    const payload = JSON.parse(storage.webhooks[0]!.payload_json) as Record<string, any>;
    expect(payload.event).toBe('invoice.confirmed');
    expect(payload.chain).toBe('base');
    expect(payload.invoice_id).toBe('inv_fixed_1');
    expect(payload.metadata.mode).toBe('fixed-address');
    expect(payload.metadata.ref).toBe('inv_fixed_1');
    expect(payload.metadata.nonce).toBe(42);
  });

  it('emits payment.orphan and never confirms when no invoice matches the value', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseChain(),
      rpcFetch(100n, [makeLog(50_000123n)]), // unknown value
    );
    await watcher.pollOnce();

    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(1);
    const payload = JSON.parse(storage.webhooks[0]!.payload_json) as Record<string, unknown>;
    expect(payload.event).toBe('payment.orphan');
    expect(payload.value).toBe('50000123');
  });

  it('processes a duplicate txHash:logIndex at most once across polls', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseChain(),
      rpcFetch(100n, [makeLog(29_000042n)]),
    );
    await watcher.pollOnce();
    await watcher.pollOnce();
    expect(storage.webhooks).toHaveLength(1);
  });

  it('waits for minConfirmations, then confirms on a later poll', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042', chain: 'eth' })]);
    // ethereum minConfirmations = 2. Log at block 100; latest 100 → 1 conf (too few).
    const tooFresh = makeWatcher(storage, ethChain(), rpcFetch(100n, [makeLog(29_000042n)]));
    await tooFresh.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);

    // latest 101 → 2 confs → matured.
    const matured = makeWatcher(storage, ethChain(), rpcFetch(101n, [makeLog(29_000042n)]));
    await matured.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
    expect(storage.webhooks).toHaveLength(1);
  });

  it('does not match an invoice whose value differs by more than the nonce range', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseChain(),
      rpcFetch(100n, [makeLog(29_000041n)]), // off by one → no exact match → orphan
    );
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(JSON.parse(storage.webhooks[0]!.payload_json).event).toBe('payment.orphan');
  });
});

/** A fetch that routes per-URL so each RPC endpoint can return its own view. */
function quorumFetch(
  perUrl: Record<string, { latest: bigint; logs: RpcLog[] } | null>,
): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const view = perUrl[url];
    if (!view) {
      // Simulate an offline / erroring endpoint.
      return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
    }
    const { method } = JSON.parse(init.body) as { method: string };
    const result =
      method === 'eth_blockNumber'
        ? '0x' + view.latest.toString(16)
        : method === 'eth_getLogs'
          ? view.logs
          : null;
    return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function baseChainQuorum(urls: string[]): FixedChainConfig {
  return { ...EVM_CHAIN_REGISTRY.base!, rpcUrl: urls[0]!, rpcUrls: urls };
}

describe('FixedAddressWatcher RPC quorum (Z76, FIX 2)', () => {
  const A = 'https://rpc-a.test';
  const B = 'https://rpc-b.test';
  const C = 'https://rpc-c.test';

  it('confirms only when >=2 endpoints agree on the same tx+value', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const fetchImpl = quorumFetch({
      [A]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [B]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [C]: { latest: 100n, logs: [makeLog(29_000042n)] },
    });
    const watcher = makeWatcher(storage, baseChainQuorum([A, B, C]), fetchImpl);
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
    expect(storage.webhooks).toHaveLength(1);
  });

  it('leaves the invoice awaiting when only ONE of N endpoints responds (degraded, no quorum)', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const fetchImpl = quorumFetch({
      [A]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [B]: null, // offline
      [C]: null, // offline
    });
    const watcher = makeWatcher(storage, baseChainQuorum([A, B, C]), fetchImpl);
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
  });

  it('never confirms a value forged by a single endpoint (others disagree)', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    // A + B see the real 29.000042; C forges a different value that would match
    // no invoice anyway — but crucially it can never reach quorum on its own.
    const fetchImpl = quorumFetch({
      [A]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [B]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [C]: { latest: 100n, logs: [makeLog(29_000042n, { transactionHash: '0xforged' })] },
    });
    const watcher = makeWatcher(storage, baseChainQuorum([A, B, C]), fetchImpl);
    await watcher.pollOnce();
    // The honest value reached quorum (A+B) → confirmed once; the forged tx
    // (1 vote) neither confirmed nor orphaned.
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
    const events = storage.webhooks.map((w) => JSON.parse(w.payload_json).event);
    expect(events.filter((e) => e === 'invoice.confirmed')).toHaveLength(1);
    expect(events).not.toContain('payment.orphan');
  });

  it('does not confirm when two endpoints report DIFFERENT values (no agreement)', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const fetchImpl = quorumFetch({
      [A]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [B]: { latest: 100n, logs: [makeLog(29_000043n)] }, // disagree on value
    });
    const watcher = makeWatcher(storage, baseChainQuorum([A, B]), fetchImpl);
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
  });

  it('underpayment reaching quorum has no exact nonce match → orphan, never confirm', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000042' })]);
    const fetchImpl = quorumFetch({
      [A]: { latest: 100n, logs: [makeLog(29_000041n)] }, // 1 unit short
      [B]: { latest: 100n, logs: [makeLog(29_000041n)] },
    });
    const watcher = makeWatcher(storage, baseChainQuorum([A, B]), fetchImpl);
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(1);
    expect(JSON.parse(storage.webhooks[0]!.payload_json).event).toBe('payment.orphan');
  });
});

describe('FixedAddressWatcher.status', () => {
  it('reports the configured address, chains and pending count', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const watcher = makeWatcher(storage, baseChain(), rpcFetch(100n, []));
    await watcher.pollOnce();
    const s = watcher.status();
    expect(s.address).toBe(FIXED_ADDRESS);
    expect(s.chains).toEqual(['base']);
    expect(s.pendingCount).toBe(1);
    expect(s.lastPollOk).toBe(true);
  });
});
