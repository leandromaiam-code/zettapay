import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp, type AppHandle } from '../src/app.js';
import { openDb } from '../src/db.js';

const VALID_WALLET = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT';
const VALID_ATA = 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

let handle: AppHandle;

beforeEach(() => {
  const db = openDb({ filename: ':memory:' });
  handle = buildApp({ db });
});

afterEach(() => {
  handle.db.close();
});

async function createMerchant() {
  const res = await request(handle.app).post('/merchants').send({
    name: 'Demo Stand',
    wallet_pubkey: VALID_WALLET,
    usdc_ata: VALID_ATA,
  });
  return res.body as { id: number; usdcAta: string; walletPubkey: string };
}

describe('GET /simulate/:merchant', () => {
  it('returns simulated airdrop and payment for an existing merchant by id', async () => {
    const merchant = await createMerchant();
    const res = await request(handle.app).get(`/simulate/${merchant.id}`);
    expect(res.status).toBe(200);
    expect(res.body.simulated).toBe(true);
    expect(res.body.network).toBe('solana-devnet');
    expect(res.body.disclaimer).toMatch(/no real money/i);
    expect(res.body.merchant.id).toBe(merchant.id);
    expect(res.body.airdrop).toMatchObject({
      recipient: VALID_ATA,
      amount: 100,
      currency: 'USDC',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    });
    expect(res.body.airdrop.signature).toMatch(BASE58);
    expect(res.body.payment).toMatchObject({
      to: VALID_ATA,
      amount: 1,
      currency: 'USDC',
    });
    expect(res.body.payment.from).toMatch(BASE58);
    expect(res.body.payment.signature).toMatch(BASE58);
    expect(res.body.payment.recentBlockhash).toMatch(BASE58);
    expect(typeof res.body.payment.acceptedAt).toBe('number');
    expect(typeof res.body.payment.id).toBe('string');
  });

  it('resolves merchants by @-prefixed id', async () => {
    const merchant = await createMerchant();
    const res = await request(handle.app).get(`/simulate/@${merchant.id}`);
    expect(res.status).toBe(200);
    expect(res.body.merchant.id).toBe(merchant.id);
  });

  it('resolves merchants by wallet pubkey', async () => {
    const merchant = await createMerchant();
    const res = await request(handle.app).get(`/simulate/${VALID_WALLET}`);
    expect(res.status).toBe(200);
    expect(res.body.merchant.id).toBe(merchant.id);
  });

  it('records the simulated payment in the payments log', async () => {
    const merchant = await createMerchant();
    const sim = await request(handle.app).get(`/simulate/${merchant.id}`);
    const list = await request(handle.app).get('/payments');
    expect(list.status).toBe(200);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].id).toBe(sim.body.payment.id);
  });

  it('honors custom airdrop and amount query params', async () => {
    const merchant = await createMerchant();
    const res = await request(handle.app).get(
      `/simulate/${merchant.id}?airdrop=250&amount=4.5`,
    );
    expect(res.status).toBe(200);
    expect(res.body.airdrop.amount).toBe(250);
    expect(res.body.airdrop.amountMicroUsdc).toBe('250000000');
    expect(res.body.payment.amount).toBe(4.5);
    expect(res.body.payment.amountMicroUsdc).toBe('4500000');
  });

  it('returns 404 for unknown merchant id', async () => {
    const res = await request(handle.app).get('/simulate/9999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns 404 for unknown wallet pubkey', async () => {
    const res = await request(handle.app).get(
      '/simulate/So11111111111111111111111111111111111111112',
    );
    expect(res.status).toBe(404);
  });

  it('rejects out-of-range airdrop amount with 400', async () => {
    const merchant = await createMerchant();
    const res = await request(handle.app).get(
      `/simulate/${merchant.id}?airdrop=99999999999`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('produces unique signatures across calls', async () => {
    const merchant = await createMerchant();
    const a = await request(handle.app).get(`/simulate/${merchant.id}`);
    const b = await request(handle.app).get(`/simulate/${merchant.id}`);
    expect(a.body.airdrop.signature).not.toBe(b.body.airdrop.signature);
    expect(a.body.payment.signature).not.toBe(b.body.payment.signature);
    expect(a.body.payment.id).not.toBe(b.body.payment.id);
  });
});
