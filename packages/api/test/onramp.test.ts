import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp, type AppHandle } from '../src/app.js';
import { openDb } from '../src/db.js';
import {
  buildMoonPayUrl,
  loadMoonPayConfig,
  moonPayBaseUrl,
  MoonPayBuildError,
  MoonPayConfigError,
  type MoonPayConfig,
} from '../src/onramp.js';

const VALID_WALLET = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT';
const MERCHANT_ATA = 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK';

const SANDBOX_CONFIG: MoonPayConfig = {
  apiKey: 'pk_test_sandbox',
  environment: 'sandbox',
  defaultCurrencyCode: 'usdc_sol',
};

const PROD_CONFIG: MoonPayConfig = {
  apiKey: 'pk_live_prod',
  environment: 'production',
  defaultCurrencyCode: 'usdc_sol',
};

describe('moonPayBaseUrl', () => {
  it('returns sandbox base URL for sandbox env', () => {
    expect(moonPayBaseUrl('sandbox')).toBe('https://buy-sandbox.moonpay.com');
  });

  it('returns production base URL for production env', () => {
    expect(moonPayBaseUrl('production')).toBe('https://buy.moonpay.com');
  });
});

describe('loadMoonPayConfig', () => {
  it('reads config from env vars', () => {
    const config = loadMoonPayConfig({
      MOONPAY_API_KEY: 'pk_test_abc',
      MOONPAY_ENV: 'sandbox',
    });
    expect(config).toEqual({
      apiKey: 'pk_test_abc',
      environment: 'sandbox',
      defaultCurrencyCode: 'usdc_sol',
    });
  });

  it('defaults to sandbox when MOONPAY_ENV is unset', () => {
    const config = loadMoonPayConfig({ MOONPAY_API_KEY: 'pk_test_abc' });
    expect(config.environment).toBe('sandbox');
  });

  it('honors MOONPAY_ENV=production', () => {
    const config = loadMoonPayConfig({
      MOONPAY_API_KEY: 'pk_live_xyz',
      MOONPAY_ENV: 'production',
    });
    expect(config.environment).toBe('production');
  });

  it('accepts MOONPAY_ENV=prod as production alias', () => {
    const config = loadMoonPayConfig({
      MOONPAY_API_KEY: 'pk_live_xyz',
      MOONPAY_ENV: 'prod',
    });
    expect(config.environment).toBe('production');
  });

  it('honors MOONPAY_DEFAULT_CURRENCY override', () => {
    const config = loadMoonPayConfig({
      MOONPAY_API_KEY: 'pk_test_abc',
      MOONPAY_DEFAULT_CURRENCY: 'usdc',
    });
    expect(config.defaultCurrencyCode).toBe('usdc');
  });

  it('throws MoonPayConfigError when MOONPAY_API_KEY is missing', () => {
    expect(() => loadMoonPayConfig({})).toThrow(MoonPayConfigError);
  });

  it('throws when MOONPAY_ENV is invalid', () => {
    expect(() =>
      loadMoonPayConfig({ MOONPAY_API_KEY: 'pk_test', MOONPAY_ENV: 'staging' }),
    ).toThrow(MoonPayConfigError);
  });
});

describe('buildMoonPayUrl', () => {
  it('targets sandbox base URL with apiKey, currencyCode and walletAddress', () => {
    const url = new URL(buildMoonPayUrl(SANDBOX_CONFIG, { walletAddress: MERCHANT_ATA }));
    expect(url.origin).toBe('https://buy-sandbox.moonpay.com');
    expect(url.searchParams.get('apiKey')).toBe('pk_test_sandbox');
    expect(url.searchParams.get('currencyCode')).toBe('usdc_sol');
    expect(url.searchParams.get('walletAddress')).toBe(MERCHANT_ATA);
  });

  it('targets production base URL when env is production', () => {
    const url = new URL(buildMoonPayUrl(PROD_CONFIG, { walletAddress: MERCHANT_ATA }));
    expect(url.origin).toBe('https://buy.moonpay.com');
    expect(url.searchParams.get('apiKey')).toBe('pk_live_prod');
  });

  it('forwards optional fiat amount and currency', () => {
    const url = new URL(
      buildMoonPayUrl(SANDBOX_CONFIG, {
        walletAddress: MERCHANT_ATA,
        baseCurrencyAmount: 50,
        baseCurrencyCode: 'USD',
      }),
    );
    expect(url.searchParams.get('baseCurrencyAmount')).toBe('50');
    expect(url.searchParams.get('baseCurrencyCode')).toBe('usd');
  });

  it('forwards redirectURL and external ids', () => {
    const url = new URL(
      buildMoonPayUrl(SANDBOX_CONFIG, {
        walletAddress: MERCHANT_ATA,
        redirectURL: 'https://merchant.example/callback',
        externalCustomerId: 'cust-1',
        externalTransactionId: 'tx-9',
      }),
    );
    expect(url.searchParams.get('redirectURL')).toBe('https://merchant.example/callback');
    expect(url.searchParams.get('externalCustomerId')).toBe('cust-1');
    expect(url.searchParams.get('externalTransactionId')).toBe('tx-9');
  });

  it('rejects empty walletAddress', () => {
    expect(() => buildMoonPayUrl(SANDBOX_CONFIG, { walletAddress: '' })).toThrow(MoonPayBuildError);
  });

  it('rejects non-positive baseCurrencyAmount', () => {
    expect(() =>
      buildMoonPayUrl(SANDBOX_CONFIG, { walletAddress: MERCHANT_ATA, baseCurrencyAmount: 0 }),
    ).toThrow(MoonPayBuildError);
    expect(() =>
      buildMoonPayUrl(SANDBOX_CONFIG, { walletAddress: MERCHANT_ATA, baseCurrencyAmount: -10 }),
    ).toThrow(MoonPayBuildError);
  });

  it('rejects malformed redirectURL', () => {
    expect(() =>
      buildMoonPayUrl(SANDBOX_CONFIG, {
        walletAddress: MERCHANT_ATA,
        redirectURL: 'not-a-url',
      }),
    ).toThrow(MoonPayBuildError);
  });

  it('uses configured default currency when input.currencyCode is omitted', () => {
    const url = new URL(
      buildMoonPayUrl(
        { ...SANDBOX_CONFIG, defaultCurrencyCode: 'eth' },
        { walletAddress: MERCHANT_ATA },
      ),
    );
    expect(url.searchParams.get('currencyCode')).toBe('eth');
  });
});

describe('POST /onramp', () => {
  let handle: AppHandle;

  beforeEach(() => {
    const db = openDb({ filename: ':memory:' });
    handle = buildApp({ db, moonPay: SANDBOX_CONFIG });
  });

  afterEach(() => {
    handle.db.close();
  });

  async function seedMerchant() {
    const res = await request(handle.app).post('/merchants').send({
      name: 'Acme',
      wallet_pubkey: VALID_WALLET,
      usdc_ata: MERCHANT_ATA,
    });
    return res.body as { id: number; usdcAta: string };
  }

  it('returns a MoonPay sandbox URL targeting the merchant ATA', async () => {
    const merchant = await seedMerchant();
    const res = await request(handle.app)
      .post('/onramp')
      .send({ merchant_id: merchant.id });
    expect(res.status).toBe(200);
    expect(res.body.environment).toBe('sandbox');
    expect(res.body.merchantId).toBe(merchant.id);
    expect(res.body.walletAddress).toBe(MERCHANT_ATA);
    const url = new URL(res.body.url);
    expect(url.origin).toBe('https://buy-sandbox.moonpay.com');
    expect(url.searchParams.get('walletAddress')).toBe(MERCHANT_ATA);
    expect(url.searchParams.get('apiKey')).toBe('pk_test_sandbox');
    expect(url.searchParams.get('currencyCode')).toBe('usdc_sol');
  });

  it('forwards optional fiat amount and external ids', async () => {
    const merchant = await seedMerchant();
    const res = await request(handle.app).post('/onramp').send({
      merchant_id: merchant.id,
      base_currency_amount: 25,
      base_currency_code: 'usd',
      external_customer_id: 'cust-42',
      redirect_url: 'https://merchant.example/done',
    });
    expect(res.status).toBe(200);
    const url = new URL(res.body.url);
    expect(url.searchParams.get('baseCurrencyAmount')).toBe('25');
    expect(url.searchParams.get('baseCurrencyCode')).toBe('usd');
    expect(url.searchParams.get('externalCustomerId')).toBe('cust-42');
    expect(url.searchParams.get('redirectURL')).toBe('https://merchant.example/done');
  });

  it('returns 404 for unknown merchant', async () => {
    const res = await request(handle.app).post('/onramp').send({ merchant_id: 9999 });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 400 when payload is missing required field', async () => {
    const res = await request(handle.app).post('/onramp').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('returns 400 for malformed redirect_url', async () => {
    const merchant = await seedMerchant();
    const res = await request(handle.app)
      .post('/onramp')
      .send({ merchant_id: merchant.id, redirect_url: 'not-a-url' });
    expect(res.status).toBe(400);
  });
});

describe('POST /onramp when MoonPay is not configured', () => {
  let handle: AppHandle;

  beforeEach(() => {
    const db = openDb({ filename: ':memory:' });
    handle = buildApp({ db, moonPay: null });
  });

  afterEach(() => {
    handle.db.close();
  });

  it('returns 503 with onramp_disabled', async () => {
    const res = await request(handle.app).post('/onramp').send({ merchant_id: 1 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('onramp_disabled');
  });
});

describe('MCP tools/call create_onramp_url', () => {
  let handle: AppHandle;

  beforeEach(() => {
    const db = openDb({ filename: ':memory:' });
    handle = buildApp({ db, moonPay: PROD_CONFIG });
  });

  afterEach(() => {
    handle.db.close();
  });

  async function seedMerchant() {
    const res = await request(handle.app).post('/merchants').send({
      name: 'Acme',
      wallet_pubkey: VALID_WALLET,
      usdc_ata: MERCHANT_ATA,
    });
    return res.body as { id: number };
  }

  it('builds a production URL targeting the merchant ATA', async () => {
    const merchant = await seedMerchant();
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'create_onramp_url',
          arguments: { merchantId: merchant.id, baseCurrencyAmount: 100 },
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBeUndefined();
    const payload = JSON.parse(res.body.result.content[0].text);
    expect(payload.environment).toBe('production');
    expect(payload.merchantId).toBe(merchant.id);
    expect(payload.walletAddress).toBe(MERCHANT_ATA);
    const url = new URL(payload.url);
    expect(url.origin).toBe('https://buy.moonpay.com');
    expect(url.searchParams.get('walletAddress')).toBe(MERCHANT_ATA);
    expect(url.searchParams.get('baseCurrencyAmount')).toBe('100');
  });

  it('returns isError when merchant is missing', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_onramp_url', arguments: { merchantId: 9999 } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('not_found');
  });

  it('returns isError when merchantId is invalid', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_onramp_url', arguments: { merchantId: 'abc' } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('invalid_arguments');
  });
});

describe('MCP tools/call create_onramp_url when disabled', () => {
  let handle: AppHandle;

  beforeEach(() => {
    const db = openDb({ filename: ':memory:' });
    handle = buildApp({ db, moonPay: null });
  });

  afterEach(() => {
    handle.db.close();
  });

  it('returns onramp_disabled isError', async () => {
    const res = await request(handle.app)
      .post('/mcp')
      .send({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_onramp_url', arguments: { merchantId: 1 } },
      });
    expect(res.body.result.isError).toBe(true);
    const err = JSON.parse(res.body.result.content[0].text);
    expect(err.error.code).toBe('onramp_disabled');
  });
});
