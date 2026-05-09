import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZettaPayClient, ZettaPayError } from '../src/index.js';
import { startFixture, makeSignedTransactionBase64, type Fixture } from './server-fixture.js';

const VALID_WALLET_A = '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT';
const VALID_WALLET_B = 'So11111111111111111111111111111111111111112';
const VALID_ATA_A = 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK';
const VALID_ATA_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

let fixture: Fixture;
let client: ZettaPayClient;

beforeEach(async () => {
  fixture = await startFixture();
  client = new ZettaPayClient({ baseURL: fixture.baseURL });
});

afterEach(async () => {
  await fixture.close();
});

describe('ZettaPayClient construction', () => {
  it('throws when baseURL is missing', () => {
    expect(() => new ZettaPayClient({ baseURL: '' })).toThrow(/baseURL is required/);
  });
});

describe('health()', () => {
  it('returns service status', async () => {
    const health = await client.health();
    expect(health).toEqual({ status: 'ok', merchants: 0, payments: 0 });
  });
});

describe('registerMerchant() / getMerchant() / listMerchants()', () => {
  it('round-trips a merchant', async () => {
    const merchant = await client.registerMerchant({
      name: 'Acme Coffee',
      walletPubkey: VALID_WALLET_A,
      usdcAta: VALID_ATA_A,
    });
    expect(merchant).toMatchObject({
      id: expect.any(Number),
      name: 'Acme Coffee',
      walletPubkey: VALID_WALLET_A,
      usdcAta: VALID_ATA_A,
      createdAt: expect.any(Number),
    });

    const fetched = await client.getMerchant(merchant.id);
    expect(fetched).toEqual(merchant);

    const list = await client.listMerchants({ limit: 10 });
    expect(list.count).toBe(1);
    expect(list.items[0]).toEqual(merchant);
  });

  it('throws ZettaPayError with API code on duplicate wallet', async () => {
    await client.registerMerchant({
      name: 'Acme',
      walletPubkey: VALID_WALLET_A,
      usdcAta: VALID_ATA_A,
    });
    let captured: ZettaPayError | null = null;
    try {
      await client.registerMerchant({
        name: 'Other',
        walletPubkey: VALID_WALLET_A,
        usdcAta: VALID_ATA_B,
      });
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured).toBeInstanceOf(ZettaPayError);
    expect(captured?.code).toBe('conflict');
    expect(captured?.status).toBe(409);
  });

  it('throws ZettaPayError when merchant id missing', async () => {
    let captured: ZettaPayError | null = null;
    try {
      await client.getMerchant(999);
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured?.code).toBe('not_found');
    expect(captured?.status).toBe(404);
  });

  it('throws ZettaPayError on validation errors', async () => {
    let captured: ZettaPayError | null = null;
    try {
      await client.registerMerchant({
        name: '',
        walletPubkey: 'not-a-key',
        usdcAta: VALID_ATA_A,
      });
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured?.code).toBe('bad_request');
    expect(captured?.status).toBe(400);
    expect(captured?.details).toBeDefined();
  });
});

describe('updateMerchant() / deleteMerchant()', () => {
  it('patches and removes a merchant', async () => {
    const merchant = await client.registerMerchant({
      name: 'Acme',
      walletPubkey: VALID_WALLET_A,
      usdcAta: VALID_ATA_A,
    });
    const patched = await client.updateMerchant(merchant.id, {
      name: 'Acme v2',
      walletPubkey: VALID_WALLET_B,
    });
    expect(patched.name).toBe('Acme v2');
    expect(patched.walletPubkey).toBe(VALID_WALLET_B);

    await client.deleteMerchant(merchant.id);
    let captured: ZettaPayError | null = null;
    try {
      await client.getMerchant(merchant.id);
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured?.code).toBe('not_found');
  });
});

describe('pay() / getPayment() / listPayments()', () => {
  it('submits a signed transaction and recovers it via getPayment', async () => {
    const tx = makeSignedTransactionBase64();
    const receipt = await client.pay({ transaction: tx });
    expect(receipt.accepted).toBe(true);
    expect(receipt.signatureCount).toBe(1);
    expect(receipt.paymentId).toEqual(expect.any(String));

    const record = await client.getPayment(receipt.paymentId);
    expect(record.id).toBe(receipt.paymentId);
    expect(record.feePayer).toBe(receipt.feePayer);

    const list = await client.listPayments({ limit: 5 });
    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe(receipt.paymentId);
  });

  it('accepts a raw base64 string as input', async () => {
    const tx = makeSignedTransactionBase64();
    const receipt = await client.pay(tx);
    expect(receipt.accepted).toBe(true);
  });

  it('accepts a Uint8Array transaction and base64-encodes it', async () => {
    const tx = makeSignedTransactionBase64();
    const bytes = Buffer.from(tx, 'base64');
    const receipt = await client.pay(bytes);
    expect(receipt.accepted).toBe(true);
  });

  it('throws when transaction is empty', async () => {
    await expect(client.pay({ transaction: '' })).rejects.toThrow(/transaction is required/);
  });

  it('surfaces x402 validation errors as ZettaPayError', async () => {
    let captured: ZettaPayError | null = null;
    try {
      await client.pay({ transaction: '@@not-base64@@' });
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured).toBeInstanceOf(ZettaPayError);
    expect(captured?.code).toBe('invalid_encoding');
    expect(captured?.status).toBe(400);
  });

  it('returns 404 for unknown payment id', async () => {
    let captured: ZettaPayError | null = null;
    try {
      await client.getPayment('does-not-exist');
    } catch (err) {
      captured = err as ZettaPayError;
    }
    expect(captured?.code).toBe('not_found');
    expect(captured?.status).toBe(404);
  });

  it('rejects empty payment id at the SDK boundary', async () => {
    await expect(client.getPayment('')).rejects.toThrow(/id is required/);
  });
});
