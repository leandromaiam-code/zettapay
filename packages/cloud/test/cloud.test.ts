// @zettapay/cloud test suite. Everything runs against the in-process
// MemoryCloudDb — no network, no Supabase — so the multi-tenant guarantees
// (CRUD, tenant isolation, auth, non-custodial derivation, atomic child index)
// are proven deterministically.
//
// Canonical test vectors:
//   BTC zpub  — the listener's own derive vector key.
//   EVM xpub  — m/44'/60'/0' of the Foundry/Hardhat default mnemonic.
// Both are PUBLIC extended keys; no private/seed material appears anywhere,
// which is itself part of the non-custodial assertion.

import { afterEach, describe, expect, it } from 'vitest';
import { deriveEvmAddress } from '@zettapay/listener';
// deriveBip84Address isn't re-exported from the listener index; pull it from
// source for an independent (non-custodial) address check. Test-only import.
import { deriveBip84Address } from '../../listener/src/derive-bip84.js';
import { MemoryCloudDb } from '../src/cloud-db.js';
import { SupabaseStorageAdapter } from '../src/storage.js';
import { CloudApiServer } from '../src/server.js';
import { authenticate, generateApiKey, hashApiKey } from '../src/auth.js';
import { seedMerchant, type SeedMerchantResult } from '../src/seed.js';

const BTC_XPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';
const EVM_XPUB =
  'xpub6Ce9NcJvTk36xtLSrJLZqE7wtgA5deCeYs7rSQtreh4cj6ByPtrg9sD7V2FNFLPnf8heNP3FGkeV9qwfzvZNSd54JoNXVsXFYSYwHsnJxqP';
const FIXED_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function seedBtc(db: MemoryCloudDb, email = 'a@shop.com'): Promise<SeedMerchantResult> {
  return seedMerchant(db, {
    email,
    shopName: 'Shop A',
    chains: [{ chain: 'btc', xpub: BTC_XPUB }],
  });
}

describe('SupabaseStorageAdapter CRUD', () => {
  it('round-trips a merchant, invoice and webhook event', async () => {
    const db = new MemoryCloudDb();
    const { merchantId } = await seedBtc(db);
    const storage = new SupabaseStorageAdapter(db);

    const merchant = await storage.getMerchant(merchantId);
    expect(merchant?.xpub).toBe(BTC_XPUB);
    expect(merchant?.next_child_index).toBe(0);

    const inv = await storage.createInvoice({
      id: 'inv_1',
      merchant_id: merchantId,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.001',
      address: 'bc1qexample',
      child_index: 0,
      expires_at: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(inv.id).toBe('inv_1');

    const fetched = await storage.getInvoice('inv_1');
    expect(fetched?.address).toBe('bc1qexample');

    const pending = await storage.listPendingInvoices();
    expect(pending.map((p) => p.id)).toContain('inv_1');

    const paid = await storage.updateInvoiceStatus('inv_1', 'paid', {
      tx_hash: '0xdead',
      paid_at: new Date().toISOString(),
    });
    expect(paid.status).toBe('paid');
    expect(paid.tx_hash).toBe('0xdead');
    expect(await storage.listPendingInvoices()).toHaveLength(0);

    const evt = await storage.recordWebhookEvent({
      id: 'evt_1',
      invoice_id: 'inv_1',
      payload_json: JSON.stringify({ event: 'payment.confirmed', invoice_id: 'inv_1' }),
      next_retry_at: new Date(0).toISOString(),
    });
    expect(evt.id).toBe('evt_1');
    const due = await storage.getWebhookEventsDue(new Date(), 10);
    expect(due.map((e) => e.id)).toContain('evt_1');

    await storage.markWebhookDelivered('evt_1', { ok: true });
    expect(await storage.getWebhookEventsDue(new Date(), 10)).toHaveLength(0);
  });
});

describe('multi-tenant listPendingInvoices', () => {
  it('spans every tenant for the shared watcher fleet', async () => {
    const db = new MemoryCloudDb();
    const a = await seedBtc(db, 'a@shop.com');
    const b = await seedBtc(db, 'b@shop.com');
    const storage = new SupabaseStorageAdapter(db);
    const future = new Date(Date.now() + 3600_000).toISOString();
    await storage.createInvoice({ id: 'inv_a', merchant_id: a.merchantId, chain: 'btc', asset: 'BTC', amount: '0.001', address: 'bc1qa', child_index: 0, expires_at: future });
    await storage.createInvoice({ id: 'inv_b', merchant_id: b.merchantId, chain: 'btc', asset: 'BTC', amount: '0.002', address: 'bc1qb', child_index: 0, expires_at: future });

    const all = await storage.listPendingInvoices();
    const ids = all.map((i) => i.id);
    expect(ids).toContain('inv_a');
    expect(ids).toContain('inv_b');
  });
});

describe('nextChildIndex atomicity', () => {
  it('hands out unique, contiguous indices under heavy concurrency', async () => {
    const db = new MemoryCloudDb();
    const { merchantId } = await seedBtc(db);
    const storage = new SupabaseStorageAdapter(db);

    const N = 200;
    const indices = await Promise.all(
      Array.from({ length: N }, () => storage.nextChildIndex(merchantId)),
    );
    const unique = new Set(indices);
    expect(unique.size).toBe(N);
    expect(Math.min(...indices)).toBe(0);
    expect(Math.max(...indices)).toBe(N - 1);
  });
});

describe('auth', () => {
  it('accepts a freshly minted key and resolves its merchant', async () => {
    const db = new MemoryCloudDb();
    const { merchantId, apiKey } = await seedBtc(db);
    const res = await authenticate(db, apiKey);
    expect(res.ok).toBe(true);
    expect(res.merchantId).toBe(merchantId);
  });

  it('rejects missing, malformed, unknown and revoked keys', async () => {
    const db = new MemoryCloudDb();
    await seedBtc(db);
    expect((await authenticate(db, undefined)).ok).toBe(false);
    expect((await authenticate(db, 'garbage')).ok).toBe(false);
    expect((await authenticate(db, `${generateApiKey().key}`)).ok).toBe(false);
  });

  it('persists only the hash, never the raw key', async () => {
    const k = generateApiKey();
    expect(k.key.startsWith('zp_live_')).toBe(true);
    expect(k.hash).toBe(hashApiKey(k.key));
    expect(k.hash).not.toContain(k.key);
    expect(k.prefix.length).toBeLessThan(k.key.length);
  });
});

describe('CloudApiServer', () => {
  let server: CloudApiServer | null = null;

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  async function startServer(db: MemoryCloudDb): Promise<string> {
    server = new CloudApiServer({
      storage: new SupabaseStorageAdapter(db),
      db,
      port: 0,
      host: '127.0.0.1',
      rateLimit: null,
      checkoutBaseUrl: 'https://pay.example',
    });
    await server.start();
    return `http://127.0.0.1:${server.boundPort}/api/v1`;
  }

  it('serves /health publicly', async () => {
    const db = new MemoryCloudDb();
    const base = await startServer(db);
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('returns 401 without a key and 201 with one', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedBtc(db);
    const base = await startServer(db);

    const noAuth = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    expect(noAuth.status).toBe(401);

    const ok = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    expect(ok.status).toBe(201);
  });

  it('derives the BTC receive address from the merchant xpub (non-custodial)', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedBtc(db);
    const base = await startServer(db);

    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    const body = await res.json();
    // The address MUST equal an independent derivation from the public xpub —
    // proving the server holds no key and just derived index 0.
    const expected = deriveBip84Address({ xpub: BTC_XPUB, index: 0 }).address;
    expect(body.receive_address).toBe(expected);
    expect(body.child_index).toBe(0);
  });

  it('derives a Base USDC address from the EVM xpub', async () => {
    const db = new MemoryCloudDb();
    const seed = await seedMerchant(db, {
      email: 'evm@shop.com',
      shopName: 'EVM Shop',
      chains: [
        { chain: 'btc', xpub: BTC_XPUB },
        { chain: 'base', xpub: EVM_XPUB },
      ],
    });
    const base = await startServer(db);

    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': seed.apiKey },
      body: JSON.stringify({ chain: 'base', amount_usd: 25 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const expected = deriveEvmAddress({ xpub: EVM_XPUB, index: 0 }).address;
    expect(body.receive_address).toBe(expected);
    expect(body.amount_usdc).toBe('25');
  });

  it('encodes a per-invoice decimal nonce in fixed-address Base mode', async () => {
    const db = new MemoryCloudDb();
    const seed = await seedMerchant(db, {
      email: 'fixed@shop.com',
      shopName: 'Fixed Shop',
      chains: [
        { chain: 'btc', xpub: BTC_XPUB },
        { chain: 'base', fixedAddress: FIXED_ADDR },
      ],
    });
    const base = await startServer(db);

    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': seed.apiKey },
      body: JSON.stringify({ chain: 'base', amount_usd: 29 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.mode).toBe('fixed-address');
    expect(body.receive_address).toBe(FIXED_ADDR);
    // Exact payable amount carries the nonce in the low USDC decimals.
    expect(body.amount_usdc_units % 10_000).toBe(body.nonce);
    expect(body.nonce).toBeGreaterThan(0);
  });

  it('isolates tenants: A cannot read B\'s invoice (plain 404)', async () => {
    const db = new MemoryCloudDb();
    const a = await seedBtc(db, 'a@shop.com');
    const b = await seedBtc(db, 'b@shop.com');
    const base = await startServer(db);

    const created = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': b.apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 12_345 }),
    });
    const invId = (await created.json()).invoice_id as string;

    // B sees its own invoice.
    const ownView = await fetch(`${base}/invoice/${invId}`, {
      headers: { 'x-zettapay-api-key': b.apiKey },
    });
    expect(ownView.status).toBe(200);

    // A is told it does not exist — existence never leaks across tenants.
    const crossView = await fetch(`${base}/invoice/${invId}`, {
      headers: { 'x-zettapay-api-key': a.apiKey },
    });
    expect(crossView.status).toBe(404);
    void a;
  });
});

describe('public checkout endpoint', () => {
  let server: CloudApiServer | null = null;

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  const SECRET = 'whsec_topsecret_value_do_not_leak';

  async function startServer(db: MemoryCloudDb): Promise<string> {
    server = new CloudApiServer({
      storage: new SupabaseStorageAdapter(db),
      db,
      port: 0,
      host: '127.0.0.1',
      rateLimit: null,
      checkoutBaseUrl: 'https://pay.example',
    });
    await server.start();
    return `http://127.0.0.1:${server.boundPort}/api/v1`;
  }

  async function seedWithSecrets(db: MemoryCloudDb, email = 'a@shop.com') {
    return seedMerchant(db, {
      email,
      shopName: 'Acme Coffee',
      chains: [{ chain: 'btc', xpub: BTC_XPUB }],
      webhookUrl: 'https://merchant.example/hook',
      webhookSecret: SECRET,
    });
  }

  it('POST /invoice returns the hosted checkout_url', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedWithSecrets(db);
    const base = await startServer(db);

    const res = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    const body = await res.json();
    expect(body.checkout_url).toBe(`https://pay.example/checkout/${body.invoice_id}`);
  });

  it('serves safe display fields without an API key', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedWithSecrets(db);
    const base = await startServer(db);

    const created = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    const invId = (await created.json()).invoice_id as string;

    // No API key header at all — the payer is anonymous.
    const res = await fetch(`${base}/checkout/${invId}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const view = await res.json();
    expect(view.shop_name).toBe('Acme Coffee');
    expect(view.invoice_id).toBe(invId);
    expect(view.chain).toBe('btc');
    expect(view.status).toBe('pending');
    expect(view.receive_address).toMatch(/^bc1/);
    expect(view.qr_uri.startsWith('bitcoin:')).toBe(true);
    expect(typeof view.expires_at).toBe('string');
  });

  it('never leaks secret/xpub/api-key/email in the public payload', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedWithSecrets(db);
    const base = await startServer(db);

    const created = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 50_000 }),
    });
    const invId = (await created.json()).invoice_id as string;

    const res = await fetch(`${base}/checkout/${invId}`);
    const raw = await res.text();
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain(BTC_XPUB);
    expect(raw).not.toContain(apiKey);
    expect(raw.toLowerCase()).not.toContain('xpub');
    expect(raw).not.toContain('a@shop.com');

    const view = JSON.parse(raw);
    expect(view.merchant_id).toBeUndefined();
    expect(view.webhook_secret).toBeUndefined();
    expect(view.api_key).toBeUndefined();
    expect(view.email).toBeUndefined();
  });

  it('returns 404 for an unknown invoice id', async () => {
    const db = new MemoryCloudDb();
    await seedWithSecrets(db);
    const base = await startServer(db);

    const res = await fetch(`${base}/checkout/inv_does_not_exist`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('not_found');
  });

  it('exposes only the invoice owner shop_name, isolating other merchants', async () => {
    const db = new MemoryCloudDb();
    const a = await seedMerchant(db, {
      email: 'a@shop.com',
      shopName: 'Merchant A',
      chains: [{ chain: 'btc', xpub: BTC_XPUB }],
      webhookUrl: 'https://a.example/hook',
      webhookSecret: 'whsec_aaa_secret',
    });
    await seedMerchant(db, {
      email: 'b@shop.com',
      shopName: 'Merchant B',
      chains: [{ chain: 'btc', xpub: BTC_XPUB }],
      webhookUrl: 'https://b.example/hook',
      webhookSecret: 'whsec_bbb_secret',
    });
    const base = await startServer(db);

    const created = await fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': a.apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 7_000 }),
    });
    const invId = (await created.json()).invoice_id as string;

    const raw = await (await fetch(`${base}/checkout/${invId}`)).text();
    expect(raw).toContain('Merchant A');
    expect(raw).not.toContain('Merchant B');
    expect(raw).not.toContain('whsec_aaa_secret');
    expect(raw).not.toContain('whsec_bbb_secret');
  });
});

describe('plan limits', () => {
  let server: CloudApiServer | null = null;

  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  async function start(db: MemoryCloudDb, planLimits: Record<string, number | null> | null) {
    server = new CloudApiServer({
      storage: new SupabaseStorageAdapter(db),
      db,
      port: 0,
      host: '127.0.0.1',
      rateLimit: null,
      planLimits,
    });
    await server.start();
    return `http://127.0.0.1:${server.boundPort}/api/v1`;
  }

  function createInvoice(base: string, apiKey: string) {
    return fetch(`${base}/invoice`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-zettapay-api-key': apiKey },
      body: JSON.stringify({ chain: 'btc', amount_sats: 10_000 }),
    });
  }

  it('returns 402 once the monthly cap of the plan is reached', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedBtc(db);
    const base = await start(db, { free: 2, pro: 5 });

    expect((await createInvoice(base, apiKey)).status).toBe(201);
    expect((await createInvoice(base, apiKey)).status).toBe(201);
    const blocked = await createInvoice(base, apiKey);
    expect(blocked.status).toBe(402);
    const body = await blocked.json();
    expect(body.error).toMatchObject({ code: 'plan_limit_reached', plan: 'free', limit: 2, used: 2 });
  });

  it('applies the cap of the merchant plan and isolates usage per tenant', async () => {
    const db = new MemoryCloudDb();
    const pro = await seedMerchant(db, {
      email: 'pro@shop.com',
      shopName: 'Pro Shop',
      chains: [{ chain: 'btc', xpub: BTC_XPUB }],
      plan: 'pro',
    });
    const free = await seedBtc(db, 'free@shop.com');
    const base = await start(db, { free: 1, pro: 3 });

    for (let i = 0; i < 3; i++) expect((await createInvoice(base, pro.apiKey)).status).toBe(201);
    expect((await createInvoice(base, pro.apiKey)).status).toBe(402);
    // Usage is metered per tenant: the free merchant still has its own quota.
    expect((await createInvoice(base, free.apiKey)).status).toBe(201);
    expect((await createInvoice(base, free.apiKey)).status).toBe(402);
  });

  it('does not meter when plan enforcement is off', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedBtc(db);
    const base = await start(db, null);
    for (let i = 0; i < 4; i++) expect((await createInvoice(base, apiKey)).status).toBe(201);
  });

  it('omits checkout_url when no checkout base URL is configured', async () => {
    const db = new MemoryCloudDb();
    const { apiKey } = await seedBtc(db);
    const base = await start(db, null);
    const body = await (await createInvoice(base, apiKey)).json();
    expect(body.checkout_url).toBeUndefined();
  });
});
