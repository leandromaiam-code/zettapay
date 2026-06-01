// USDT on Base (Z77) — a SECOND token on the same Base chain that already
// serves USDC, in the fixed-address mode (modo endereço-fixo). USDT Base is 6
// decimals like USDC, so the decimal-nonce encoding is identical; only the
// token contract changes. These tests assert:
//   - invoice-core resolves asset='usdt' → USDT contract + symbol on the invoice
//   - the watcher matches a USDT Transfer to a USDT invoice (by exact value)
//   - a USDC payment never satisfies a USDT invoice and vice versa (no mixing)
//   - the default (asset unset) path stays IDENTICAL to USDC-only behavior
//   - the RPC quorum applies independently to each token
//   - POST /invoice {chain:base, asset:usdt} returns USDT + token_address + nonce
//
// Everything is additive: BTC and the USDC xpub mode are never touched here.

import { afterEach, describe, expect, it } from 'vitest';
import {
  FixedAddressWatcher,
  EVM_CHAIN_REGISTRY,
  lookupEvmToken,
  parseEvmTokens,
  type EvmTokenSpec,
  type FixedChainConfig,
} from '../src/fixed-address-watcher.js';
import { createFixedEvmInvoiceForMerchant } from '../src/invoice-core.js';
import { AppServer } from '../src/http-server.js';
import type { ListenerStatus } from '../src/listener.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type {
  Invoice,
  InvoiceInput,
  InvoiceStatus,
  ListPendingInvoicesOpts,
  Merchant,
  WebhookEvent,
  WebhookEventInput,
} from '../src/types.js';

const FIXED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';

const USDC_TOKEN: EvmTokenSpec = { symbol: 'USDC', address: USDC_BASE, decimals: 6 };
const USDT_TOKEN: EvmTokenSpec = { symbol: 'USDT', address: USDT_BASE, decimals: 6 };

function makeInvoice(over: Partial<Invoice> = {}): Invoice {
  return {
    id: over.id ?? 'inv_fixed_1',
    merchant_id: 'm1',
    chain: over.chain ?? 'base',
    asset: over.asset ?? 'USDC',
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
  merchant: Merchant;

  constructor(seed: Invoice[] = []) {
    for (const inv of seed) this.invoices.set(inv.id, inv);
    this.merchant = {
      id: 'm1',
      shop_name: 'shop',
      email: 'a@b.c',
      xpub: 'zpub-not-used-in-fixed-mode',
      webhook_url: 'https://x.test/hook',
      webhook_secret_hash: 'h',
      next_child_index: 0,
      created_at: new Date().toISOString(),
    };
  }

  async getMerchant(_id: string): Promise<Merchant | null> {
    return this.merchant;
  }

  async listPendingInvoices(opts?: ListPendingInvoicesOpts): Promise<Invoice[]> {
    return [...this.invoices.values()].filter(
      (i) => i.status === 'pending' && (!opts?.chain || i.chain === opts.chain),
    );
  }

  async getInvoice(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }

  async createInvoice(input: InvoiceInput): Promise<Invoice> {
    const now = new Date().toISOString();
    const inv: Invoice = {
      ...input,
      status: input.status ?? 'pending',
      paid_at: null,
      tx_hash: null,
      created_at: now,
      updated_at: now,
    };
    this.invoices.set(inv.id, inv);
    return inv;
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

/**
 * A fetch that returns eth_getLogs results keyed by the queried token CONTRACT
 * address (params[0].address), mirroring real RPC behavior where a getLogs
 * filtered on the USDT contract never returns USDC transfers.
 */
function tokenRpcFetch(latest: bigint, logsByToken: Record<string, RpcLog[]>): typeof fetch {
  return (async (_url: string, init: { body: string }) => {
    const parsed = JSON.parse(init.body) as { method: string; params: unknown[] };
    let result: unknown = null;
    if (parsed.method === 'eth_blockNumber') {
      result = '0x' + latest.toString(16);
    } else if (parsed.method === 'eth_getLogs') {
      const addr = String((parsed.params[0] as { address: string }).address).toLowerCase();
      result = logsByToken[addr] ?? [];
    }
    return { ok: true, status: 200, json: async () => ({ result }) } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** Base chain with BOTH tokens enabled (USDC default + USDT). */
function baseBothTokens(): FixedChainConfig {
  return {
    ...EVM_CHAIN_REGISTRY.base!,
    rpcUrl: 'https://rpc.test',
    enabledTokens: [USDC_TOKEN, USDT_TOKEN],
  };
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

describe('registry: USDT on Base', () => {
  it('lists USDT as a second token on Base with 6 decimals', () => {
    const base = EVM_CHAIN_REGISTRY.base!;
    expect(base.tokens.map((t) => t.symbol)).toEqual(['USDC', 'USDT']);
    const usdt = lookupEvmToken(base, 'usdt');
    expect(usdt).toEqual({ symbol: 'USDT', address: USDT_BASE, decimals: 6 });
    // default + unknown
    expect(lookupEvmToken(base, undefined)?.symbol).toBe('USDC');
    expect(lookupEvmToken(base, 'dai')).toBeNull();
  });

  it('USDT is NOT available on USDC-only chains (ethereum/polygon)', () => {
    expect(lookupEvmToken(EVM_CHAIN_REGISTRY.ethereum!, 'usdt')).toBeNull();
    expect(lookupEvmToken(EVM_CHAIN_REGISTRY.polygon!, 'usdt')).toBeNull();
  });

  it('parseEvmTokens defaults to USDC and always implies it', () => {
    expect(parseEvmTokens(undefined)).toEqual(['USDC']);
    expect(parseEvmTokens('usdc,usdt')).toEqual(['USDC', 'USDT']);
    expect(parseEvmTokens('usdt')).toEqual(['USDC', 'USDT']); // USDC implied
    expect(parseEvmTokens('usdt,bogus')).toEqual(['USDC', 'USDT']);
  });
});

describe('invoice-core: fixed-address asset branch', () => {
  it('asset=usdt → USDT symbol, USDT contract, nonce, USDT qr_uri', async () => {
    const storage = new FakeStorage();
    const r = await createFixedEvmInvoiceForMerchant(storage as unknown as StorageAdapter, 'm1', {
      amountUsd: 29,
      fixedAddress: FIXED_ADDRESS,
      chainAlias: 'base',
      asset: 'usdt',
    });
    expect(r.asset).toBe('USDT');
    expect(r.tokenAddress).toBe(USDT_BASE);
    expect(r.invoice.asset).toBe('USDT');
    expect(r.invoice.address).toBe(FIXED_ADDRESS);
    expect(r.invoice.child_index).toBeNull();
    expect(r.nonce).toBeGreaterThanOrEqual(1);
    expect(r.nonce).toBeLessThanOrEqual(9999);
    // exact amount = base(29_000000) + nonce
    expect(r.amountUsdcUnits).toBe(29_000000n + BigInt(r.nonce));
    expect(r.eip681).toContain(`ethereum:${USDT_BASE}@8453/transfer`);
    expect(r.eip681).toContain(`uint256=${r.amountUsdcUnits.toString()}`);
  });

  it('asset unset → identical USDC behavior (default)', async () => {
    const storage = new FakeStorage();
    const r = await createFixedEvmInvoiceForMerchant(storage as unknown as StorageAdapter, 'm1', {
      amountUsd: 29,
      fixedAddress: FIXED_ADDRESS,
      chainAlias: 'base',
    });
    expect(r.asset).toBe('USDC');
    expect(r.tokenAddress).toBe(USDC_BASE);
    expect(r.invoice.asset).toBe('USDC');
    expect(r.eip681).toContain(`ethereum:${USDC_BASE}@8453/transfer`);
  });

  it('USDC and USDT have independent nonce spaces at the same price', async () => {
    const storage = new FakeStorage();
    const usdc = await createFixedEvmInvoiceForMerchant(storage as unknown as StorageAdapter, 'm1', {
      amountUsd: 29,
      fixedAddress: FIXED_ADDRESS,
      chainAlias: 'base',
      asset: 'usdc',
    });
    const usdt = await createFixedEvmInvoiceForMerchant(storage as unknown as StorageAdapter, 'm1', {
      amountUsd: 29,
      fixedAddress: FIXED_ADDRESS,
      chainAlias: 'base',
      asset: 'usdt',
    });
    // Different tokens → both may legitimately reuse the same nonce since the
    // watcher segregates by token. (We don't assert equality — only that the
    // USDT allocation is not blocked by the USDC one.)
    expect(usdc.asset).toBe('USDC');
    expect(usdt.asset).toBe('USDT');
  });

  it('rejects usdt on a USDC-only chain', async () => {
    const storage = new FakeStorage();
    await expect(
      createFixedEvmInvoiceForMerchant(storage as unknown as StorageAdapter, 'm1', {
        amountUsd: 29,
        fixedAddress: FIXED_ADDRESS,
        chainAlias: 'polygon',
        asset: 'usdt',
      }),
    ).rejects.toThrow(/not available on chain "polygon"/);
  });
});

describe('FixedAddressWatcher: USDT vs USDC matching', () => {
  it('confirms a USDT invoice from a USDT-contract Transfer (by exact value)', async () => {
    const storage = new FakeStorage([makeInvoice({ asset: 'USDT', amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseBothTokens(),
      tokenRpcFetch(100n, { [USDT_BASE.toLowerCase()]: [makeLog(29_000042n)] }),
    );
    await watcher.pollOnce();

    const inv = storage.invoices.get('inv_fixed_1');
    expect(inv?.status).toBe('confirmed');
    const payload = JSON.parse(storage.webhooks[0]!.payload_json) as Record<string, any>;
    expect(payload.event).toBe('invoice.confirmed');
    expect(payload.asset).toBe('USDT');
    expect(payload.token_address).toBe(USDT_BASE);
    expect(payload.metadata.asset).toBe('USDT');
    expect(payload.metadata.nonce).toBe(42);
  });

  it('a USDC payment does NOT confirm a USDT invoice (no mixing)', async () => {
    const storage = new FakeStorage([makeInvoice({ asset: 'USDT', amount: '29000042' })]);
    // Same value arrives on the USDC contract, nothing on USDT.
    const watcher = makeWatcher(
      storage,
      baseBothTokens(),
      tokenRpcFetch(100n, { [USDC_BASE.toLowerCase()]: [makeLog(29_000042n)] }),
    );
    await watcher.pollOnce();

    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    // The USDC transfer matches no USDC invoice → orphan, asset USDC.
    const orphan = storage.webhooks.find(
      (w) => (JSON.parse(w.payload_json) as { event: string }).event === 'payment.orphan',
    );
    expect(orphan).toBeTruthy();
    expect((JSON.parse(orphan!.payload_json) as { asset: string }).asset).toBe('USDC');
  });

  it('a USDT payment does NOT confirm a USDC invoice (reverse direction)', async () => {
    const storage = new FakeStorage([makeInvoice({ asset: 'USDC', amount: '29000042' })]);
    const watcher = makeWatcher(
      storage,
      baseBothTokens(),
      tokenRpcFetch(100n, { [USDT_BASE.toLowerCase()]: [makeLog(29_000042n)] }),
    );
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
  });

  it('confirms USDC and USDT invoices in the SAME poll, each by its own token', async () => {
    const storage = new FakeStorage([
      makeInvoice({ id: 'inv_usdc', asset: 'USDC', amount: '29000011' }),
      makeInvoice({ id: 'inv_usdt', asset: 'USDT', amount: '29000022' }),
    ]);
    const watcher = makeWatcher(
      storage,
      baseBothTokens(),
      tokenRpcFetch(100n, {
        [USDC_BASE.toLowerCase()]: [makeLog(29_000011n, { transactionHash: '0xc', logIndex: '0x1' })],
        [USDT_BASE.toLowerCase()]: [makeLog(29_000022n, { transactionHash: '0xd', logIndex: '0x2' })],
      }),
    );
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_usdc')?.status).toBe('confirmed');
    expect(storage.invoices.get('inv_usdt')?.status).toBe('confirmed');
  });
});

describe('FixedAddressWatcher: USDC default unchanged', () => {
  it('a USDC-only chain (no enabledTokens) confirms a USDC invoice as before', async () => {
    const storage = new FakeStorage([makeInvoice({ asset: 'USDC', amount: '29000042' })]);
    const usdcOnly: FixedChainConfig = { ...EVM_CHAIN_REGISTRY.base!, rpcUrl: 'https://rpc.test' };
    const watcher = makeWatcher(
      storage,
      usdcOnly,
      tokenRpcFetch(100n, { [USDC_BASE.toLowerCase()]: [makeLog(29_000042n)] }),
    );
    await watcher.pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('confirmed');
    // No USDT scan happened → exactly one webhook, no spurious orphan.
    expect(storage.webhooks).toHaveLength(1);
  });
});

describe('FixedAddressWatcher: RPC quorum applies per token', () => {
  it('a USDT confirmation requires the quorum to agree on the USDT value', async () => {
    const U1 = 'https://rpc-1.test';
    const U2 = 'https://rpc-2.test';
    const storage = new FakeStorage([makeInvoice({ asset: 'USDT', amount: '29000042' })]);
    const chain: FixedChainConfig = {
      ...EVM_CHAIN_REGISTRY.base!,
      rpcUrl: U1,
      rpcUrls: [U1, U2],
      enabledTokens: [USDC_TOKEN, USDT_TOKEN],
    };
    // U1 agrees; U2 forges a different USDT value for the same tx → conflict, no confirm.
    const fetchImpl = (async (url: string, init: { body: string }) => {
      const parsed = JSON.parse(init.body) as { method: string; params: unknown[] };
      if (parsed.method === 'eth_blockNumber') {
        return { ok: true, status: 200, json: async () => ({ result: '0x64' }) } as unknown as Response;
      }
      const addr = String((parsed.params[0] as { address: string }).address).toLowerCase();
      let logs: RpcLog[] = [];
      if (addr === USDT_BASE.toLowerCase()) {
        logs = url === U1 ? [makeLog(29_000042n)] : [makeLog(99_000042n)];
      }
      return { ok: true, status: 200, json: async () => ({ result: logs }) } as unknown as Response;
    }) as unknown as typeof fetch;

    await makeWatcher(storage, chain, fetchImpl).pollOnce();
    expect(storage.invoices.get('inv_fixed_1')?.status).toBe('pending');
    expect(storage.webhooks).toHaveLength(0);
  });
});

// ---- AppServer POST /invoice {chain:base, asset:usdt} -----------------------

const status: () => ListenerStatus = () => ({
  wsConnected: true,
  subscribedCount: 0,
  lastEventAt: null,
  lastBlockHeight: null,
  uptimeSeconds: 1,
});

let server: AppServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

async function startServer(
  storage: FakeStorage,
  opts: Partial<ConstructorParameters<typeof AppServer>[0]> = {},
): Promise<string> {
  server = new AppServer({
    port: 0,
    statusProvider: status,
    storage: storage as unknown as StorageAdapter,
    merchantId: 'm1',
    fixedEvmAddress: FIXED_ADDRESS,
    fixedEvmChains: ['base'],
    fixedEvmTokens: ['usdc', 'usdt'],
    rateLimit: null,
    ...opts,
  });
  await server.start();
  return `http://127.0.0.1:${server.boundPort}`;
}

describe('POST /invoice {chain:base, asset:usdt}', () => {
  it('returns USDT invoice with token_address, nonce and fixed address', async () => {
    const storage = new FakeStorage();
    const base = await startServer(storage);
    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', asset: 'usdt', amount_usd: 29 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.asset).toBe('USDT');
    expect(body.token_address).toBe(USDT_BASE);
    expect(body.receive_address).toBe(FIXED_ADDRESS);
    expect(body.mode).toBe('fixed-address');
    expect(body.nonce).toBeGreaterThanOrEqual(1);
    expect(body.qr_uri).toContain(USDT_BASE);
  });

  it('chain:base with no asset → USDC (identical to before)', async () => {
    const storage = new FakeStorage();
    const base = await startServer(storage);
    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', amount_usd: 29 }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, any>;
    expect(body.asset).toBe('USDC');
    expect(body.token_address).toBe(USDC_BASE);
    expect(body.qr_uri).toContain(USDC_BASE);
  });

  it('rejects asset=usdt when MERCHANT_EVM_TOKENS excludes it', async () => {
    const storage = new FakeStorage();
    const base = await startServer(storage, { fixedEvmTokens: ['usdc'] });
    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'base', asset: 'usdt', amount_usd: 29 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('asset_disabled');
  });
});
