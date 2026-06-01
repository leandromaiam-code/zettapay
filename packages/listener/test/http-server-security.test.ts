// http-server security tests (Z76 FIX 1 + FIX 3): constant-time API-key
// comparison and POST /invoice rate limiting. Uses a real node:http server on
// an ephemeral port with a minimal storage stub. No network beyond localhost.

import { afterEach, describe, expect, it } from 'vitest';
import { AppServer, timingSafeStrEqual } from '../src/http-server.js';
import type { ListenerStatus } from '../src/listener.js';
import type { StorageAdapter } from '../src/storage/index.js';

const status: () => ListenerStatus = () => ({
  wsConnected: true,
  subscribedCount: 0,
  lastEventAt: null,
  lastBlockHeight: null,
  uptimeSeconds: 1,
});

// Storage is never reached in these tests: a wrong key (401) and the rate limit
// (429) both short-circuit before invoice creation. The stub throws if touched.
const throwingStorage = new Proxy(
  {},
  {
    get() {
      return () => {
        throw new Error('storage must not be reached in this test');
      };
    },
  },
) as unknown as StorageAdapter;

let server: AppServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

async function startServer(opts: Partial<ConstructorParameters<typeof AppServer>[0]> = {}) {
  server = new AppServer({
    port: 0,
    statusProvider: status,
    storage: throwingStorage,
    merchantId: 'm1',
    ...opts,
  });
  await server.start();
  return `http://127.0.0.1:${server.boundPort}`;
}

describe('timingSafeStrEqual', () => {
  it('accepts an exact match and rejects a wrong key', () => {
    expect(timingSafeStrEqual('s3cr3t-key', 's3cr3t-key')).toBe(true);
    expect(timingSafeStrEqual('s3cr3t-key', 's3cr3t-keX')).toBe(false);
  });

  it('rejects on length mismatch without throwing (no early length leak)', () => {
    expect(timingSafeStrEqual('short', 'a-much-longer-key')).toBe(false);
    expect(timingSafeStrEqual('', 'x')).toBe(false);
    expect(timingSafeStrEqual('', '')).toBe(true);
  });
});

describe('POST /invoice API key (constant-time)', () => {
  it('rejects a wrong key with 401 and accepts the correct one past auth', async () => {
    const base = await startServer({ apiKey: 'right-key' });

    const bad = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'wrong-key' },
      body: JSON.stringify({ amount_sats: 1000 }),
    });
    expect(bad.status).toBe(401);

    // Correct key passes auth; storage stub then throws → surfaced as 500. The
    // point is that auth did NOT short-circuit, proving the key was accepted.
    const good = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'right-key' },
      body: JSON.stringify({ amount_sats: 1000 }),
    });
    expect(good.status).toBe(500);
  });
});

describe('POST /invoice rate limit', () => {
  it('returns 429 once the per-IP window is exceeded', async () => {
    // perIp=2: first two requests pass the limiter (and 401 on the wrong key),
    // the third trips the limiter BEFORE auth → 429 with Retry-After.
    const base = await startServer({
      apiKey: 'k',
      rateLimit: { perIpPerWindow: 2, globalPerWindow: 100, windowMs: 60_000 },
    });
    const send = () =>
      fetch(`${base}/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'nope' },
        body: '{}',
      });

    expect((await send()).status).toBe(401);
    expect((await send()).status).toBe(401);
    const limited = await send();
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
    const body = (await limited.json()) as { error: { code: string } };
    expect(body.error.code).toBe('rate_limited');
  });

  it('does not rate-limit when disabled (rateLimit: null)', async () => {
    const base = await startServer({ apiKey: 'k', rateLimit: null });
    for (let i = 0; i < 5; i += 1) {
      const r = await fetch(`${base}/invoice`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-zettapay-api-key': 'nope' },
        body: '{}',
      });
      expect(r.status).toBe(401); // always auth-rejected, never 429
    }
  });
});
