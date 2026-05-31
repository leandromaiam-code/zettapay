// AppServer security tests (Z76) — timing-safe API key (FIX 1), rate-limit 429
// (FIX 3) and the production prod-guard (FIX 4). Driven over loopback with an
// in-memory storage; no network beyond localhost.

import { afterEach, describe, expect, it } from 'vitest';
import { AppServer, timingSafeStrEqual } from '../src/http-server.js';
import { SlidingWindowRateLimiter } from '../src/rate-limit.js';
import type { ListenerStatus } from '../src/listener.js';
import type { StorageAdapter } from '../src/storage/index.js';
import type { Invoice } from '../src/types.js';

const XPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const status: ListenerStatus = {
  wsConnected: true,
  subscribedCount: 0,
  lastEventAt: null,
  lastBlockHeight: null,
  uptimeSeconds: 1,
};

class FakeStorage implements Partial<StorageAdapter> {
  private idx = 0;
  private invoices = new Map<string, Invoice>();

  async getMerchant(id: string) {
    return { id, xpub: XPUB, webhook_url: 'https://example.test/hook', created_at: '' } as never;
  }
  async nextChildIndex(): Promise<number> {
    return this.idx++;
  }
  async createInvoice(input: Partial<Invoice>): Promise<Invoice> {
    const inv = {
      status: 'pending',
      paid_at: null,
      tx_hash: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...input,
    } as Invoice;
    this.invoices.set(inv.id, inv);
    return inv;
  }
  async getInvoice(id: string): Promise<Invoice | null> {
    return this.invoices.get(id) ?? null;
  }
}

const servers: AppServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function startServer(opts: Partial<ConstructorParameters<typeof AppServer>[0]> = {}) {
  const server = new AppServer({
    port: 0,
    host: '127.0.0.1',
    statusProvider: () => status,
    storage: new FakeStorage() as unknown as StorageAdapter,
    merchantId: 'm1',
    ...opts,
  });
  servers.push(server);
  await server.start();
  return server;
}

describe('timingSafeStrEqual (FIX 1)', () => {
  it('is true only for an exact match', () => {
    expect(timingSafeStrEqual('secret-key', 'secret-key')).toBe(true);
    expect(timingSafeStrEqual('secret-key', 'secret-keX')).toBe(false);
  });

  it('returns false (no throw) on a length mismatch', () => {
    expect(timingSafeStrEqual('short', 'a-much-longer-key')).toBe(false);
    expect(timingSafeStrEqual('', 'x')).toBe(false);
  });
});

describe('AppServer auth (FIX 1)', () => {
  it('rejects a wrong API key with 401', async () => {
    const server = await startServer({ apiKey: 'topsecret' });
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'wrong' },
      body: JSON.stringify({ chain: 'btc', amount_sats: 1000 }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts the correct API key and creates an invoice', async () => {
    const server = await startServer({ apiKey: 'topsecret' });
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'topsecret' },
      body: JSON.stringify({ chain: 'btc', amount_sats: 1000 }),
    });
    expect(res.status).toBe(201);
  });
});

describe('AppServer rate-limit (FIX 3)', () => {
  it('returns 429 once the per-IP window is exhausted', async () => {
    const limiter = new SlidingWindowRateLimiter({ perIpPerMin: 1, globalPerMin: 0 });
    const server = await startServer({ apiKey: 'k', rateLimiter: limiter });
    const url = `http://127.0.0.1:${server.boundPort}/invoice`;
    const headers = { 'content-type': 'application/json', 'x-zettapay-api-key': 'k' };
    const body = JSON.stringify({ chain: 'btc', amount_sats: 1000 });

    const first = await fetch(url, { method: 'POST', headers, body });
    expect(first.status).toBe(201);

    const second = await fetch(url, { method: 'POST', headers, body });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBe('60');
    const j = (await second.json()) as { error: { code: string } };
    expect(j.error.code).toBe('rate_limited');
  });
});

describe('AppServer prod-guard (FIX 4)', () => {
  it('refuses to start in production without an API key', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const server = new AppServer({
        port: 0,
        host: '127.0.0.1',
        statusProvider: () => status,
        storage: new FakeStorage() as unknown as StorageAdapter,
        merchantId: 'm1',
      });
      await expect(server.start()).rejects.toThrow(/ZETTAPAY_API_KEY is required/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('starts in production WITH an API key', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const server = await startServer({ apiKey: 'k' });
      expect(server.boundPort).toBeGreaterThan(0);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
