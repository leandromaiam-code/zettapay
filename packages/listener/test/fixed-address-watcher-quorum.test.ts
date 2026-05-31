// FixedAddressWatcher RPC-quorum tests (Z76 FIX 2). A confirmation requires a
// quorum of independent RPCs to AGREE on the same (tx, value) with enough
// confirmations; a lone or hostile source can never decide. Mocked multi-RPC
// fetch keyed by url — no real network.

import { describe, expect, it } from 'vitest';
import {
  FixedAddressWatcher,
  EVM_CHAIN_REGISTRY,
  type FixedChainConfig,
} from '../src/fixed-address-watcher.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type {
  Invoice,
  InvoiceStatus,
  ListPendingInvoicesOpts,
  WebhookEvent,
  WebhookEventInput,
} from '../src/types.js';

const FIXED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const U1 = 'https://rpc-1.test';
const U2 = 'https://rpc-2.test';
const U3 = 'https://rpc-3.test';

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: over.id ?? 'inv_fixed_1',
    merchant_id: 'm1',
    chain: over.chain ?? 'base',
    asset: 'USDC',
    amount: over.amount ?? '29000042',
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
  async updateInvoiceStatus(id: string, status: InvoiceStatus, patch?: Partial<Invoice>): Promise<Invoice> {
    const inv = this.invoices.get(id);
    if (!inv) throw new Error('not found');
    const next = { ...inv, status, ...patch, updated_at: new Date().toISOString() };
    this.invoices.set(id, next);
    return next;
  }
  async recordWebhookEvent(evt: WebhookEventInput): Promise<WebhookEvent> {
    const full: WebhookEvent = { ...evt, attempts: 0, delivered_at: null, last_status_code: null, last_error: null };
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

type RpcReply = { latest: bigint; logs: RpcLog[] } | 'fail';

/** A fetch routed by url; 'fail' simulates an offline / erroring endpoint. */
function multiRpcFetch(byUrl: Record<string, RpcReply>): typeof fetch {
  return (async (url: string, init: { body: string }) => {
    const reply = byUrl[url];
    if (!reply || reply === 'fail') {
      return { ok: false, status: 502, json: async () => ({}) } as unknown as Response;
    }
    const { method } = JSON.parse(init.body) as { method: string };
    const result =
      method === 'eth_blockNumber'
        ? '0x' + reply.latest.toString(16)
        : method === 'eth_getLogs'
          ? reply.logs
          : null;
    return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

function baseChain(urls: string[]): FixedChainConfig {
  return { ...EVM_CHAIN_REGISTRY.base!, rpcUrl: urls[0]!, rpcUrls: urls };
}

function makeWatcher(storage: FakeStorage, chain: FixedChainConfig, fetchImpl: typeof fetch) {
  return new FixedAddressWatcher({
    storage: storage as unknown as StorageAdapter,
    merchantId: 'm1',
    address: FIXED_ADDRESS,
    chains: [chain],
    pollIntervalMs: 999_999,
    fetchImpl,
  });
}

describe('FixedAddressWatcher quorum', () => {
  it('confirms when 2 RPCs agree on the value', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const fetchImpl = multiRpcFetch({
      [U1]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [U2]: { latest: 100n, logs: [makeLog(29_000042n)] },
    });
    await makeWatcher(storage, baseChain([U1, U2]), fetchImpl).pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
    expect(storage.webhooks).toHaveLength(1);
  });

  it('does NOT confirm (degraded → awaiting) when only 1 of 2 RPCs responds', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const fetchImpl = multiRpcFetch({
      [U1]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [U2]: 'fail',
    });
    const watcher = makeWatcher(storage, baseChain([U1, U2]), fetchImpl);
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
    expect(watcher.status().lastPollOk).toBe(false); // degraded
  });

  it('does NOT confirm when one RPC forges a different value (conflict)', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const fetchImpl = multiRpcFetch({
      [U1]: { latest: 100n, logs: [makeLog(29_000042n)] }, // honest
      [U2]: { latest: 100n, logs: [makeLog(99_000042n)] }, // forged value, same tx
    });
    await makeWatcher(storage, baseChain([U1, U2]), fetchImpl).pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
  });

  it('an honest 2-of-3 majority confirms despite a forging RPC', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const fetchImpl = multiRpcFetch({
      [U1]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [U2]: { latest: 100n, logs: [makeLog(29_000042n)] },
      [U3]: { latest: 100n, logs: [makeLog(12_345678n)] }, // forged minority
    });
    await makeWatcher(storage, baseChain([U1, U2, U3]), fetchImpl).pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
  });
});
