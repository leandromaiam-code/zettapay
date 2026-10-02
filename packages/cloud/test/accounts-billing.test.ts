// Self-serve accounts, subscription billing, the outbound-URL guard and the
// fixed-address fleet. Everything runs in-process against MemoryCloudDb: no
// network, no Supabase, no Stripe.

import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { Accounts } from '../src/accounts.js';
import { Billing } from '../src/billing.js';
import { MemoryCloudDb } from '../src/cloud-db.js';
import { FixedAddressFleet } from '../src/fixed-fleet.js';
import { assertPublicHttpsUrl, isNonPublicAddress } from '../src/net-guard.js';
import { effectivePlan } from '../src/plans.js';
import { seedMerchant } from '../src/seed.js';
import { CloudApiServer } from '../src/server.js';
import { SupabaseStorageAdapter } from '../src/storage.js';

const BTC_XPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';
const FIXED_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const PUBLIC_DNS = async () => ['93.184.216.34'];
const LIMITS = { free: 2, starter: 5, pro: 9, unlimited: null };
const PRICES = { starter: 19, pro: 49 };

describe('outbound URL guard', () => {
  it('classifies loopback, private, link-local and bridge addresses as non-public', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.18.0.1', '192.168.1.9', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1']) {
      expect(isNonPublicAddress(ip), ip).toBe(true);
    }
    expect(isNonPublicAddress('93.184.216.34')).toBe(false);
    expect(isNonPublicAddress('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects http, credentials, odd ports, IP literals and names that resolve inward', async () => {
    await expect(assertPublicHttpsUrl('http://shop.example/hook', PUBLIC_DNS)).rejects.toThrow(/https/);
    await expect(assertPublicHttpsUrl('https://u:p@shop.example/hook', PUBLIC_DNS)).rejects.toThrow(/credentials/);
    await expect(assertPublicHttpsUrl('https://shop.example:8443/hook', PUBLIC_DNS)).rejects.toThrow(/port/);
    await expect(assertPublicHttpsUrl('https://172.18.0.1/hook', PUBLIC_DNS)).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://localhost/hook', PUBLIC_DNS)).rejects.toThrow(/public/);
    await expect(assertPublicHttpsUrl('https://evil.example/hook', async () => ['10.0.0.5'])).rejects.toThrow(/non-public/);
    await expect(assertPublicHttpsUrl('https://shop.example/hook', PUBLIC_DNS)).resolves.toBeInstanceOf(URL);
  });
});

describe('signup', () => {
  const accounts = (db: MemoryCloudDb) => new Accounts({ db, planLimits: LIMITS, lookup: PUBLIC_DNS });

  it('creates a free merchant from public material and returns the key once', async () => {
    const db = new MemoryCloudDb();
    const out = await accounts(db).signup({
      email: 'Owner@Shop.com',
      shop_name: 'Acme',
      btc_xpub: BTC_XPUB,
      base_address: FIXED_ADDR,
      webhook_url: 'https://shop.example/hook',
    });
    expect(out.api_key).toMatch(/^zp_live_[0-9a-f]{48}$/);
    expect(out.webhook_secret).toMatch(/^whsec_/);
    expect(out.plan).toBe('free');

    const view = await accounts(db).overview(out.merchant_id);
    expect(view).toMatchObject({ shop_name: 'Acme', email: 'owner@shop.com', plan: 'free' });
    expect(view.usage).toEqual({ invoices_this_month: 0, monthly_limit: 2 });
    // The overview never carries the key, its hash or the webhook secret.
    const json = JSON.stringify(view);
    expect(json).not.toContain(out.api_key);
    expect(json).not.toContain(out.webhook_secret as string);
    expect(json).not.toContain('api_key_hash');
  });

  it('refuses a private key, a duplicate email, a missing receive method and an inward webhook', async () => {
    const db = new MemoryCloudDb();
    const a = accounts(db);
    await expect(
      a.signup({ email: 'a@shop.com', shop_name: 'Acme', btc_xpub: `zprv${'x'.repeat(107)}` }),
    ).rejects.toMatchObject({ code: 'private_key_rejected' });
    await expect(a.signup({ email: 'a@shop.com', shop_name: 'Acme' })).rejects.toMatchObject({ code: 'no_receive_method' });
    await expect(
      new Accounts({ db, planLimits: LIMITS, lookup: async () => ['172.18.0.1'] }).signup({
        email: 'a@shop.com',
        shop_name: 'Acme',
        btc_xpub: BTC_XPUB,
        webhook_url: 'https://internal.example/hook',
      }),
    ).rejects.toMatchObject({ code: 'invalid_webhook_url' });

    await a.signup({ email: 'a@shop.com', shop_name: 'Acme', btc_xpub: BTC_XPUB });
    await expect(a.signup({ email: 'A@shop.com', shop_name: 'Other', btc_xpub: BTC_XPUB })).rejects.toMatchObject({
      code: 'email_taken',
      status: 409,
    });
  });
});

describe('account API', () => {
  let server: CloudApiServer | null = null;
  afterEach(async () => {
    if (server) await server.stop();
    server = null;
  });

  async function start(db: MemoryCloudDb, extra: Partial<ConstructorParameters<typeof CloudApiServer>[0]> = {}) {
    server = new CloudApiServer({
      storage: new SupabaseStorageAdapter(db),
      db,
      port: 0,
      host: '127.0.0.1',
      rateLimit: null,
      planLimits: LIMITS,
      planPrices: PRICES,
      accounts: new Accounts({ db, planLimits: LIMITS, lookup: PUBLIC_DNS }),
      signupRateLimit: null,
      ...extra,
    });
    await server.start();
    return `http://127.0.0.1:${server.boundPort}/api/v1`;
  }

  const post = (url: string, body: unknown, key?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { 'x-zettapay-api-key': key } : {}) },
      body: JSON.stringify(body),
    });

  it('signs up over HTTP, then serves /me and /invoices only to the owner', async () => {
    const db = new MemoryCloudDb();
    const base = await start(db);
    const res = await post(`${base}/signup`, { email: 'a@shop.com', shop_name: 'Acme', btc_xpub: BTC_XPUB });
    expect(res.status).toBe(201);
    const { api_key } = (await res.json()) as { api_key: string };

    expect((await fetch(`${base}/me`)).status).toBe(401);
    expect((await post(`${base}/invoice`, { chain: 'btc', amount_sats: 20_000 }, api_key)).status).toBe(201);

    const me = (await (await fetch(`${base}/me`, { headers: { 'x-zettapay-api-key': api_key } })).json()) as {
      usage: { invoices_this_month: number };
    };
    expect(me.usage.invoices_this_month).toBe(1);

    const other = await seedMerchant(db, { email: 'b@shop.com', shopName: 'B', chains: [{ chain: 'btc', xpub: BTC_XPUB }] });
    const mine = (await (await fetch(`${base}/invoices`, { headers: { 'x-zettapay-api-key': api_key } })).json()) as {
      invoices: unknown[];
    };
    const theirs = (await (await fetch(`${base}/invoices`, { headers: { 'x-zettapay-api-key': other.apiKey } })).json()) as {
      invoices: unknown[];
    };
    expect(mine.invoices).toHaveLength(1);
    expect(theirs.invoices).toHaveLength(0);
  });

  it('throttles signup per client address', async () => {
    const db = new MemoryCloudDb();
    const base = await start(db, { signupRateLimit: { perKeyPerWindow: 1, windowMs: 60_000 } });
    const body = (n: number) => ({ email: `u${n}@shop.com`, shop_name: 'Acme', btc_xpub: BTC_XPUB });
    expect((await post(`${base}/signup`, body(1))).status).toBe(201);
    expect((await post(`${base}/signup`, body(2))).status).toBe(429);
  });

  it('publishes the plan catalogue with no transaction fee', async () => {
    const db = new MemoryCloudDb();
    const base = await start(db);
    const plans = (await (await fetch(`${base}/plans`)).json()) as {
      plans: Array<{ plan: string; price_usd_per_month: number }>;
      transaction_fee: number;
    };
    expect(plans.transaction_fee).toBe(0);
    expect(plans.plans.map((p) => p.plan)).toEqual(['free', 'starter', 'pro']);
    expect(plans.plans.find((p) => p.plan === 'pro')?.price_usd_per_month).toBe(49);
  });
});

describe('billing', () => {
  async function setup(now = () => Date.now()) {
    const db = new MemoryCloudDb();
    const storage = new SupabaseStorageAdapter(db);
    const payee = await seedMerchant(db, {
      email: 'billing@zp.example',
      shopName: 'ZettaPay',
      chains: [{ chain: 'base', fixedAddress: FIXED_ADDR }],
      plan: 'unlimited',
    });
    const customer = await seedMerchant(db, { email: 'c@shop.com', shopName: 'C', chains: [{ chain: 'btc', xpub: BTC_XPUB }] });
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.example/c/cs_test_1' }), { status: 200 });
    }) as typeof fetch;
    const billing = new Billing({
      db,
      storage,
      prices: PRICES,
      billingMerchantId: payee.merchantId,
      stripe: { secretKey: 'sk_test_placeholder', webhookSecret: 'whsec_xxxxxxxxxxxxxxxxxxxxxxxx', priceIds: { starter: 'price_s', pro: 'price_p' } },
      siteUrl: 'https://pay.example/',
      fetchImpl,
      now,
    });
    return { db, storage, billing, payee, customer, calls };
  }

  it('crypto: issues an invoice to the platform merchant and activates the plan when it confirms', async () => {
    const { db, storage, billing, payee, customer } = await setup();
    const out = await billing.createCheckout(customer.merchantId, 'starter', 'crypto');
    expect(out.checkout_url).toBe(`https://pay.example/checkout/${out.invoice_id}`);
    const inv = await storage.getInvoice(out.invoice_id as string);
    expect(inv?.merchant_id).toBe(payee.merchantId);
    expect(inv?.address).toBe(FIXED_ADDR);

    await billing.reconcile();
    expect((await db.getMerchant(customer.merchantId))?.plan ?? 'free').toBe('free');

    await storage.updateInvoiceStatus(out.invoice_id as string, 'confirmed', { paid_at: new Date().toISOString() });
    await billing.reconcile();
    const merchant = await db.getMerchant(customer.merchantId);
    expect(merchant?.plan).toBe('starter');
    const days = (Date.parse(merchant?.plan_expires_at as string) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    expect(await db.listPendingCryptoSubscriptions()).toHaveLength(0);
  });

  it('a lapsed paid plan counts as free again', () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 1000).toISOString();
    expect(effectivePlan({ plan: 'pro', plan_expires_at: past })).toBe('free');
    expect(effectivePlan({ plan: 'pro', plan_expires_at: future })).toBe('pro');
    expect(effectivePlan({ plan: 'unlimited', plan_expires_at: null })).toBe('unlimited');
  });

  it('rejects unknown plans and unavailable methods', async () => {
    const { billing, customer } = await setup();
    await expect(billing.createCheckout(customer.merchantId, 'free', 'crypto')).rejects.toMatchObject({ code: 'unknown_plan' });
    await expect(billing.createCheckout(customer.merchantId, 'pro', 'wire')).rejects.toMatchObject({ code: 'method_unavailable' });
  });

  it('stripe: opens a subscription checkout and applies signed events only', async () => {
    const fixedNow = 1_800_000_000_000;
    const { db, billing, customer, calls } = await setup(() => fixedNow);
    const out = await billing.createCheckout(customer.merchantId, 'pro', 'stripe');
    expect(out.checkout_url).toContain('checkout.stripe.example');
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const sent = new URLSearchParams(calls[0]?.body);
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[0][price]')).toBe('price_p');
    expect(sent.get('metadata[merchant_id]')).toBe(customer.merchantId);

    const event = {
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', subscription: 'sub_1', metadata: { merchant_id: customer.merchantId, plan: 'pro', subscription_row: out.subscription_id } } },
    };
    const raw = JSON.stringify(event);
    const t = Math.floor(fixedNow / 1000);
    const good = createHmac('sha256', 'whsec_xxxxxxxxxxxxxxxxxxxxxxxx').update(`${t}.${raw}`).digest('hex');
    expect(billing.verifyStripeSignature(raw, `t=${t},v1=${'0'.repeat(64)}`)).toBe(false);
    expect(billing.verifyStripeSignature(raw, `t=${t - 4000},v1=${good}`)).toBe(false);
    expect(billing.verifyStripeSignature(raw, `t=${t},v1=${good}`)).toBe(true);

    await billing.handleStripeEvent(event);
    expect((await db.getMerchant(customer.merchantId))?.plan).toBe('pro');

    await billing.handleStripeEvent({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_1' } } });
    const after = await db.getMerchant(customer.merchantId);
    expect(after?.plan).toBe('free');
    expect(after?.plan_expires_at).toBeNull();
  });
});

describe('fixed-address fleet', () => {
  it('starts exactly one watcher per distinct fixed address and picks up new merchants', async () => {
    const db = new MemoryCloudDb();
    const storage = new SupabaseStorageAdapter(db);
    await seedMerchant(db, { email: 'a@shop.com', shopName: 'A', chains: [{ chain: 'base', fixedAddress: FIXED_ADDR }] });
    await seedMerchant(db, { email: 'b@shop.com', shopName: 'B', chains: [{ chain: 'base', fixedAddress: FIXED_ADDR.toLowerCase() }] });
    const started: string[] = [];
    const fleet = new FixedAddressFleet({
      storage,
      db,
      refreshMs: 60_000,
      createWatcher: (address) => ({
        start: async () => {
          started.push(address);
        },
        stop: async () => undefined,
      }),
    });
    await fleet.start();
    expect(started).toEqual([FIXED_ADDR.toLowerCase()]);

    const second = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
    await seedMerchant(db, { email: 'c@shop.com', shopName: 'C', chains: [{ chain: 'base', fixedAddress: second }] });
    await fleet.refresh();
    expect(fleet.addresses.sort()).toEqual([second.toLowerCase(), FIXED_ADDR.toLowerCase()].sort());
    await fleet.stop();
  });
});
