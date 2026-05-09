import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { buildApp, type AppHandle } from '../src/app.js';
import { openDb } from '../src/db.js';

const VALID_WALLET_A = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT';
const VALID_WALLET_B = 'So11111111111111111111111111111111111111112';
const VALID_ATA_A = 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK';
const VALID_ATA_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let handle: AppHandle;

beforeEach(() => {
  const db = openDb({ filename: ':memory:' });
  handle = buildApp({ db });
});

afterEach(() => {
  handle.db.close();
});

describe('GET /healthz', () => {
  it('returns ok with merchant count', async () => {
    const res = await request(handle.app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', merchants: 0 });
  });
});

describe('POST /merchants', () => {
  it('creates a merchant and returns 201', async () => {
    const res = await request(handle.app).post('/merchants').send({
      name: 'Acme Coffee',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: expect.any(Number),
      name: 'Acme Coffee',
      walletPubkey: VALID_WALLET_A,
      usdcAta: VALID_ATA_A,
      createdAt: expect.any(Number),
    });
  });

  it('rejects payload missing required fields with 400', async () => {
    const res = await request(handle.app).post('/merchants').send({ name: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('bad_request');
  });

  it('rejects malformed wallet pubkey with 400', async () => {
    const res = await request(handle.app).post('/merchants').send({
      name: 'Acme',
      wallet_pubkey: 'not-base58!',
      usdc_ata: VALID_ATA_A,
    });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate wallet_pubkey', async () => {
    await request(handle.app).post('/merchants').send({
      name: 'A',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    const res = await request(handle.app).post('/merchants').send({
      name: 'B',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_B,
    });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('conflict');
  });
});

describe('GET /merchants', () => {
  it('lists merchants ordered by createdAt desc', async () => {
    await request(handle.app).post('/merchants').send({
      name: 'First',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    await request(handle.app).post('/merchants').send({
      name: 'Second',
      wallet_pubkey: VALID_WALLET_B,
      usdc_ata: VALID_ATA_B,
    });

    const res = await request(handle.app).get('/merchants');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.items[0].id).toBeGreaterThan(res.body.items[1].id);
  });

  it('honors limit and offset', async () => {
    await request(handle.app).post('/merchants').send({
      name: 'First',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    await request(handle.app).post('/merchants').send({
      name: 'Second',
      wallet_pubkey: VALID_WALLET_B,
      usdc_ata: VALID_ATA_B,
    });

    const res = await request(handle.app).get('/merchants?limit=1&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });
});

describe('GET /merchants/:id', () => {
  it('returns 404 for unknown id', async () => {
    const res = await request(handle.app).get('/merchants/9999');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('not_found');
  });

  it('returns the merchant for known id', async () => {
    const created = await request(handle.app).post('/merchants').send({
      name: 'Solo',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    const res = await request(handle.app).get(`/merchants/${created.body.id}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Solo');
  });

  it('returns 400 for invalid id', async () => {
    const res = await request(handle.app).get('/merchants/abc');
    expect(res.status).toBe(400);
  });
});

describe('PATCH /merchants/:id', () => {
  it('updates the name', async () => {
    const created = await request(handle.app).post('/merchants').send({
      name: 'Old',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    const res = await request(handle.app)
      .patch(`/merchants/${created.body.id}`)
      .send({ name: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New');
  });

  it('returns 400 when no fields provided', async () => {
    const created = await request(handle.app).post('/merchants').send({
      name: 'Old',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    const res = await request(handle.app)
      .patch(`/merchants/${created.body.id}`)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(handle.app)
      .patch('/merchants/9999')
      .send({ name: 'x' });
    expect(res.status).toBe(404);
  });

  it('returns 409 when updating to a duplicate wallet_pubkey', async () => {
    const a = await request(handle.app).post('/merchants').send({
      name: 'A',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    await request(handle.app).post('/merchants').send({
      name: 'B',
      wallet_pubkey: VALID_WALLET_B,
      usdc_ata: VALID_ATA_B,
    });
    const res = await request(handle.app)
      .patch(`/merchants/${a.body.id}`)
      .send({ wallet_pubkey: VALID_WALLET_B });
    expect(res.status).toBe(409);
  });
});

describe('DELETE /merchants/:id', () => {
  it('deletes a merchant and returns 204', async () => {
    const created = await request(handle.app).post('/merchants').send({
      name: 'Doomed',
      wallet_pubkey: VALID_WALLET_A,
      usdc_ata: VALID_ATA_A,
    });
    const res = await request(handle.app).delete(`/merchants/${created.body.id}`);
    expect(res.status).toBe(204);

    const after = await request(handle.app).get(`/merchants/${created.body.id}`);
    expect(after.status).toBe(404);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(handle.app).delete('/merchants/9999');
    expect(res.status).toBe(404);
  });
});
