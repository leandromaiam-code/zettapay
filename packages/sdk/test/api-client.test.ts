// ZettaPayApi tests.
//
// Part 1 runs the client against the REAL self-hosted HTTP server
// (packages/listener/src/http-server.ts, imported from source) on an ephemeral
// localhost port, so request paths, headers and response fields are checked
// against what the listener actually serves.
//
// Part 2 uses a recording fetch for behaviour that needs ZettaPay Cloud
// (`/api/v1` prefix, 402 plan_limit_reached) — the Cloud server is not started
// here; the error body is copied from packages/cloud/src/server.ts withinPlan().

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AppServer } from '../../listener/src/http-server.js';
import type { ListenerStatus } from '../../listener/src/listener.js';
import { JsonFileStorage } from '../../listener/src/storage/json.js';
import {
  API_KEY_HEADER,
  PlanLimitReachedError,
  RateLimitedError,
  ZettaPayApi,
  ZettaPayApiError,
} from '../src/api/index.js';

// Public BIP-84 account key used across the listener's own test-suite.
const ZPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';
const FIXED_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const USDT_BASE = '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2';
const API_KEY = 'test-api-key';

const status: () => ListenerStatus = () => ({
  wsConnected: true,
  subscribedCount: 2,
  lastEventAt: 1_700_000_000_000,
  lastBlockHeight: 900_000,
  uptimeSeconds: 12,
});

let server: AppServer | null = null;
const tmpdirs: string[] = [];
afterEach(async () => {
  if (server) await server.stop();
  server = null;
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function startListener(
  opts: Partial<ConstructorParameters<typeof AppServer>[0]> = {},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-sdk-api-'));
  tmpdirs.push(dir);
  const storage = new JsonFileStorage({ dataDir: dir });
  const merchant = await storage.createMerchant({
    shop_name: 'SDK Test',
    email: 'sdk@example.test',
    xpub: ZPUB,
    webhook_url: 'https://example.test/wh',
    webhook_secret_hash: 'sha256:sdk',
  });
  server = new AppServer({
    port: 0,
    host: '127.0.0.1',
    statusProvider: status,
    storage,
    merchantId: merchant.id,
    apiKey: API_KEY,
    fixedEvmAddress: FIXED_ADDRESS,
    fixedEvmChains: ['base'],
    fixedEvmTokens: ['usdc', 'usdt'],
    rateLimit: null,
    ...opts,
  });
  await server.start();
  return `http://127.0.0.1:${server.boundPort}`;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected the call to reject');
}

describe('ZettaPayApi against the real listener HTTP server', () => {
  it('creates a BTC invoice by sats and reads it back', async () => {
    const baseUrl = await startListener();
    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });

    const created = await zp.createBtcInvoice({ amountSats: 2000, memo: 'Order 123' });
    expect(created.chain).toBe('btc');
    expect(created.asset).toBe('BTC');
    expect(created.amount_sats).toBe(2000);
    expect(created.status).toBe('pending');
    expect(created.receive_address).toMatch(/^bc1q/);
    expect(created.qr_uri).toMatch(/^bitcoin:bc1q/);
    expect(created.network).toBe('mainnet');
    expect(typeof created.derivation_path).toBe('string');
    expect(created.verify_url).toContain(created.receive_address);
    expect(created.child_index).toBe(0);
    // The self-hosted listener has no hosted checkout.
    expect(created.checkout_url).toBeUndefined();

    const fetched = await zp.getInvoice(created.invoice_id);
    expect(fetched.invoice_id).toBe(created.invoice_id);
    expect(fetched.status).toBe('pending');
    expect(fetched.receive_address).toBe(created.receive_address);
    expect(fetched.tx_hash).toBeNull();
    expect(fetched.paid_at).toBeNull();
  });

  it('honours expiresInSeconds on the listener', async () => {
    const baseUrl = await startListener();
    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });
    const created = await zp.createBtcInvoice({ amountSats: 1000, expiresInSeconds: 120 });
    const ttlMs = new Date(created.expires_at).getTime() - new Date(created.created_at).getTime();
    expect(ttlMs).toBeGreaterThan(110_000);
    expect(ttlMs).toBeLessThan(130_000);
  });

  it('creates USDC and USDT invoices on Base (fixed-address mode)', async () => {
    const baseUrl = await startListener();
    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });

    const usdc = await zp.createBaseInvoice({ amountUsd: 29 });
    expect(usdc.chain).toBe('base');
    expect(usdc.asset).toBe('USDC');
    expect(usdc.mode).toBe('fixed-address');
    expect(usdc.receive_address.toLowerCase()).toBe(FIXED_ADDRESS.toLowerCase());
    expect(usdc.amount_usd).toBe(29);
    expect(usdc.amount_usdc).toMatch(/^29\.00\d{4}$/);
    expect(usdc.amount_usdc_units).toBe(29_000_000 + (usdc.nonce as number));
    expect(usdc.qr_uri).toMatch(/^ethereum:0x/);
    expect(usdc.child_index).toBeNull();

    const usdt = await zp.createBaseInvoice({ amountUsd: 5.5, asset: 'usdt' });
    expect(usdt.asset).toBe('USDT');
    expect(usdt.token_address).toBe(USDT_BASE);
    expect(usdt.qr_uri).toContain(USDT_BASE);

    const fetched = await zp.getInvoice(usdt.invoice_id);
    expect(fetched.amount_usdc_units).toBe(usdt.amount_usdc_units);
    expect(fetched.amount_usdc).toBe(usdt.amount_usdc);
  });

  it('reports listener health with the real field names', async () => {
    const baseUrl = await startListener();
    const zp = new ZettaPayApi({ baseUrl, target: 'listener' });
    expect(await zp.health()).toEqual({
      ok: true,
      ws_connected: true,
      subscribed_count: 2,
      last_event_at: 1_700_000_000_000,
      last_block_height: 900_000,
      uptime_s: 12,
    });
  });

  it('maps server errors to ZettaPayApiError with the server code', async () => {
    const baseUrl = await startListener();

    const noKey = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: 'wrong-key' });
    const unauthorized = (await rejection(noKey.createBtcInvoice({ amountSats: 1000 }))) as ZettaPayApiError;
    expect(unauthorized).toBeInstanceOf(ZettaPayApiError);
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.code).toBe('unauthorized');

    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });
    const missing = (await rejection(zp.getInvoice('inv_does_not_exist'))) as ZettaPayApiError;
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('not_found');
  });

  it('surfaces 429 as RateLimitedError with Retry-After', async () => {
    const baseUrl = await startListener({
      rateLimit: { perIpPerWindow: 1, globalPerWindow: 100, windowMs: 60_000 },
    });
    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });
    await zp.createBtcInvoice({ amountSats: 1000 });

    const err = (await rejection(zp.createBtcInvoice({ amountSats: 1000 }))) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err).toBeInstanceOf(ZettaPayApiError);
    expect(err.status).toBe(429);
    expect(err.code).toBe('rate_limited');
    expect(err.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('refuses a USDC invoice when USDT was requested (xpub mode ignores asset)', async () => {
    // xpub mode (public BIP-32 test vector 1 key): the server always issues USDC.
    const baseUrl = await startListener({
      evmXpub:
        'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8',
    });
    const zp = new ZettaPayApi({ baseUrl, target: 'listener', apiKey: API_KEY });

    const ok = await zp.createBaseInvoice({ amountUsd: 10 });
    expect(ok.asset).toBe('USDC');
    expect(ok.mode).toBeUndefined();
    expect(typeof ok.derivation_path).toBe('string');
    expect(ok.verify_url).toContain(ok.receive_address);

    const err = (await rejection(zp.createBaseInvoice({ amountUsd: 10, asset: 'usdt' }))) as ZettaPayApiError;
    expect(err).toBeInstanceOf(ZettaPayApiError);
    expect(err.code).toBe('asset_mismatch');
    expect((err.details as { asset: string }).asset).toBe('USDC');
  });
});

interface Recorded {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function recordingFetch(
  respond: (call: Recorded) => Response | Promise<Response>,
): { fetch: typeof fetch; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Recorded = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return respond(call);
  }) as unknown as typeof fetch;
  return { fetch: impl, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('ZettaPayApi request shape', () => {
  it('uses the /api/v1 prefix for target "cloud" and sends the API key on every call', async () => {
    const rec = recordingFetch((call) =>
      call.url.endsWith('/health')
        ? json(200, { ok: true, service: 'zettapay-cloud', ts: '2026-10-02T00:00:00.000Z' })
        : json(call.method === 'POST' ? 201 : 200, {
            invoice_id: 'inv_1',
            chain: 'base',
            asset: 'USDC',
            checkout_url: 'https://pay.example.test/checkout/inv_1',
          }),
    );
    const zp = new ZettaPayApi({
      baseUrl: 'https://cloud.example.test/',
      target: 'cloud',
      apiKey: 'zk_test_key',
      fetch: rec.fetch,
    });

    const created = await zp.createBaseInvoice({ amountUsd: 42, asset: 'usdc' });
    expect(created.checkout_url).toBe('https://pay.example.test/checkout/inv_1');
    await zp.createBtcInvoice({ amountSats: 1500, memo: 'm', expiresInSeconds: 600 });
    await zp.getInvoice('inv/1');
    const health = await zp.health();
    expect('service' in health && health.service).toBe('zettapay-cloud');

    expect(rec.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://cloud.example.test/api/v1/invoice',
      'POST https://cloud.example.test/api/v1/invoice',
      'GET https://cloud.example.test/api/v1/invoice/inv%2F1',
      'GET https://cloud.example.test/api/v1/health',
    ]);
    expect(rec.calls[0]?.body).toEqual({ chain: 'base', amount_usd: 42, asset: 'usdc' });
    expect(rec.calls[1]?.body).toEqual({ chain: 'btc', amount_sats: 1500, memo: 'm', expires_in: 600 });
    for (const call of rec.calls) expect(call.headers[API_KEY_HEADER]).toBe('zk_test_key');
  });

  it('uses no prefix for target "listener" and lets pathPrefix override', async () => {
    const rec = recordingFetch(() => json(200, { invoice_id: 'inv_1' }));
    await new ZettaPayApi({ baseUrl: 'http://localhost:8787', target: 'listener', fetch: rec.fetch }).getInvoice('inv_1');
    await new ZettaPayApi({
      baseUrl: 'https://shop.example.test',
      target: 'listener',
      pathPrefix: '/pay/',
      fetch: rec.fetch,
    }).getInvoice('inv_1');
    expect(rec.calls.map((c) => c.url)).toEqual([
      'http://localhost:8787/invoice/inv_1',
      'https://shop.example.test/pay/invoice/inv_1',
    ]);
    expect(rec.calls[0]?.headers[API_KEY_HEADER]).toBeUndefined();
  });

  it('does not guess the target from the URL', () => {
    expect(
      () => new ZettaPayApi({ baseUrl: 'https://cloud.example.test/api/v1' } as never),
    ).toThrow(/target/);
    expect(() => new ZettaPayApi({ baseUrl: '', target: 'cloud' })).toThrow(/baseUrl/);
  });

  it('surfaces 402 plan_limit_reached as PlanLimitReachedError', async () => {
    const rec = recordingFetch(() =>
      json(402, {
        error: {
          code: 'plan_limit_reached',
          message: 'plan "free" allows 50 invoices per month',
          plan: 'free',
          limit: 50,
          used: 50,
        },
      }),
    );
    const zp = new ZettaPayApi({ baseUrl: 'https://cloud.example.test', target: 'cloud', apiKey: 'k', fetch: rec.fetch });

    const err = (await rejection(zp.createBtcInvoice({ amountSats: 1000 }))) as PlanLimitReachedError;
    expect(err).toBeInstanceOf(PlanLimitReachedError);
    expect(err).toBeInstanceOf(ZettaPayApiError);
    expect(err.status).toBe(402);
    expect(err.code).toBe('plan_limit_reached');
    expect(err.plan).toBe('free');
    expect(err.limit).toBe(50);
    expect(err.used).toBe(50);
    expect(err.message).toContain('50 invoices');
  });

  it('surfaces 429 from Cloud as RateLimitedError', async () => {
    const rec = recordingFetch(() =>
      json(429, { error: { code: 'rate_limited', message: 'too many invoice requests' } }, { 'retry-after': '17' }),
    );
    const zp = new ZettaPayApi({ baseUrl: 'https://cloud.example.test', target: 'cloud', apiKey: 'k', fetch: rec.fetch });
    const err = (await rejection(zp.createBaseInvoice({ amountUsd: 1 }))) as RateLimitedError;
    expect(err).toBeInstanceOf(RateLimitedError);
    expect(err.retryAfterSeconds).toBe(17);
  });

  it('validates input before any request is made', async () => {
    const rec = recordingFetch(() => json(200, {}));
    const zp = new ZettaPayApi({ baseUrl: 'http://localhost:8787', target: 'listener', fetch: rec.fetch });
    for (const p of [
      zp.createBtcInvoice({ amountSats: 0 }),
      zp.createBtcInvoice({ amountSats: 1.5 }),
      zp.createBaseInvoice({ amountUsd: -1 }),
      zp.createBaseInvoice({ amountUsd: 1, asset: 'dai' as never }),
      zp.createBtcInvoice({ amountSats: 1, expiresInSeconds: 0 }),
      zp.getInvoice(''),
    ]) {
      const err = (await rejection(p)) as ZettaPayApiError;
      expect(err).toBeInstanceOf(ZettaPayApiError);
      expect(err.code).toBe('invalid_request');
    }
    expect(rec.calls).toHaveLength(0);
  });

  it('reports non-envelope failures, network failures and timeouts', async () => {
    const html = recordingFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const a = (await rejection(
      new ZettaPayApi({ baseUrl: 'http://x.test', target: 'listener', fetch: html.fetch }).health(),
    )) as ZettaPayApiError;
    expect(a.code).toBe('http_error');
    expect(a.status).toBe(502);

    const down = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const b = (await rejection(
      new ZettaPayApi({ baseUrl: 'http://x.test', target: 'listener', fetch: down }).health(),
    )) as ZettaPayApiError;
    expect(b.code).toBe('network_error');

    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const c = (await rejection(
      new ZettaPayApi({ baseUrl: 'http://x.test', target: 'listener', fetch: hang, timeoutMs: 20 }).health(),
    )) as ZettaPayApiError;
    expect(c.code).toBe('timeout');
  });
});
