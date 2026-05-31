// BaseWatcher tests — exercised against an in-memory StorageAdapter and a
// mocked JSON-RPC `fetch`. No real network. Covers the three contract points
// from the mission:
//   - balanceOf < amount  → invoice stays pending, no webhook
//   - balanceOf >= amount → invoice confirmed + webhook recorded (chain:'base')
//   - RPC error           → invoice untouched, loop does not crash, retries
//
// These are entirely separate from the BTC listener tests; nothing here touches
// BtcListener.

import { describe, expect, it } from 'vitest';
import { BaseWatcher } from '../src/base-watcher.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type {
  Invoice,
  InvoiceStatus,
  WebhookEvent,
  WebhookEventInput,
} from '../src/types.js';

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: over.id ?? 'inv_base_1',
    merchant_id: 'm1',
    chain: 'base',
    asset: 'USDC',
    amount: over.amount ?? '29000000', // 29 USDC in base units
    address: over.address ?? '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    child_index: 0,
    status: over.status ?? 'pending',
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
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

  async listPendingInvoices(): Promise<Invoice[]> {
    return [...this.invoices.values()].filter((i) => i.status === 'pending');
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

function balanceFetch(units: bigint): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ result: '0x' + units.toString(16) }),
    }) as unknown as Response) as unknown as typeof fetch;
}

function errorFetch(): typeof fetch {
  return (async () => {
    throw new Error('ECONNREFUSED');
  }) as unknown as typeof fetch;
}

function makeWatcher(storage: FakeStorage, fetchImpl: typeof fetch): BaseWatcher {
  return new BaseWatcher({
    storage: storage as unknown as StorageAdapter,
    merchantId: 'm1',
    rpcUrl: 'https://rpc.test',
    pollIntervalMs: 999_999,
    fetchImpl,
  });
}

describe('BaseWatcher.pollOnce', () => {
  it('leaves the invoice pending when balanceOf < amount', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000000' })]);
    const watcher = makeWatcher(storage, balanceFetch(28_000_000n));
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_base_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
  });

  it('confirms + records a chain:base webhook when balanceOf >= amount', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000000' })]);
    const watcher = makeWatcher(storage, balanceFetch(29_000_000n));
    await watcher.pollOnce();

    const inv = storage.invoices.get('inv_base_1');
    expect(inv?.status).toBe('confirmed');
    expect(inv?.paid_at).toBeTruthy();

    expect(storage.webhooks).toHaveLength(1);
    const payload = JSON.parse(storage.webhooks[0]!.payload_json) as Record<string, unknown>;
    expect(payload.event).toBe('invoice.confirmed');
    expect(payload.chain).toBe('base');
    expect(payload.invoice_id).toBe('inv_base_1');
  });

  it('confirms when balance exceeds amount (overpayment)', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000000' })]);
    const watcher = makeWatcher(storage, balanceFetch(50_000_000n));
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_base_1')?.status).toBe('confirmed');
  });

  it('does not crash on RPC error and leaves the invoice pending', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const watcher = makeWatcher(storage, errorFetch());
    await expect(watcher.pollOnce()).resolves.toBeUndefined();
    expect(storage.invoices.get('inv_base_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
    expect(watcher.status().lastPollOk).toBe(false);
  });

  it('retries a previously-failed invoice on the next poll', async () => {
    const storage = new FakeStorage([makeInvoice({ amount: '29000000' })]);
    let calls = 0;
    const flakyFetch = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary');
      return {
        ok: true,
        status: 200,
        json: async () => ({ result: '0x' + (29_000_000n).toString(16) }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const watcher = makeWatcher(storage, flakyFetch);

    await watcher.pollOnce();
    expect(storage.invoices.get('inv_base_1')?.status).toBe('pending');
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_base_1')?.status).toBe('confirmed');
  });
});

describe('BaseWatcher.status', () => {
  it('reports the configured RPC + USDC address and pending count', async () => {
    const storage = new FakeStorage([makeInvoice()]);
    const watcher = makeWatcher(storage, balanceFetch(0n));
    await watcher.pollOnce();
    const s = watcher.status();
    expect(s.rpcUrl).toBe('https://rpc.test');
    expect(s.usdcAddress).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(s.pendingCount).toBe(1);
  });
});
