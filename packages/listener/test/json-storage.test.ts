import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvoiceNotFoundError,
  MerchantNotInitializedError,
} from '../src/errors.js';
import { JsonFileStorage } from '../src/storage/json.js';
import { describeStorageContract } from './storage-contract.js';

const tmpdirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-json-'));
  tmpdirs.push(dir);
  return dir;
}

describeStorageContract('json', async () => {
  const dir = await makeTmpDir();
  return new JsonFileStorage({ dataDir: dir });
});

afterAll(async () => {
  await Promise.all(
    tmpdirs.map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe('JsonFileStorage — adapter-specific behaviors', () => {
  let dataDir: string;
  let storage: JsonFileStorage;

  beforeAll(async () => {
    dataDir = await makeTmpDir();
    storage = new JsonFileStorage({ dataDir });
  });

  it('init() creates dataDir, invoices/, webhook_events/, and .lock sentinel', async () => {
    await storage.init();
    const entries = await fs.readdir(dataDir);
    expect(entries).toEqual(expect.arrayContaining(['invoices', 'webhook_events', '.lock']));
    const invoicesStat = await fs.stat(path.join(dataDir, 'invoices'));
    const eventsStat = await fs.stat(path.join(dataDir, 'webhook_events'));
    expect(invoicesStat.isDirectory()).toBe(true);
    expect(eventsStat.isDirectory()).toBe(true);
  });

  it('init() is idempotent and does not overwrite merchant.json', async () => {
    const merchant = await storage.createMerchant({
      shop_name: 'Idempotent Shop',
      email: 'idempotent@example.test',
      xpub: 'zpubExampleIdempotent',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:idempotent',
    });
    await storage.init();
    const again = await storage.createMerchant({
      shop_name: 'Should Not Apply',
      email: 'other@example.test',
      xpub: 'zpubOther',
      webhook_url: 'https://example.test/other',
      webhook_secret_hash: 'sha256:other',
    });
    expect(again.id).toBe(merchant.id);
    expect(again.shop_name).toBe('Idempotent Shop');
  });

  it('nextChildIndex throws MerchantNotInitializedError when no merchant', async () => {
    const fresh = await makeTmpDir();
    const empty = new JsonFileStorage({ dataDir: fresh });
    await empty.init();
    await expect(empty.nextChildIndex('any')).rejects.toBeInstanceOf(MerchantNotInitializedError);
  });

  it('updateInvoiceStatus throws InvoiceNotFoundError for unknown id', async () => {
    await expect(storage.updateInvoiceStatus('inv_does_not_exist', 'confirmed')).rejects.toBeInstanceOf(
      InvoiceNotFoundError,
    );
  });

  it('atomic write leaves no stray .tmp files in invoices/', async () => {
    const merchant = await storage.getMerchant('any');
    expect(merchant).not.toBeNull();
    await storage.createInvoice({
      id: 'inv_atomic_check',
      merchant_id: merchant!.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.0001',
      address: 'bc1qatomic',
      child_index: 1,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const entries = await fs.readdir(path.join(dataDir, 'invoices'));
    const strays = entries.filter((e) => e.includes('.tmp.'));
    expect(strays).toEqual([]);
  });

  it('listPendingInvoices tolerates a corrupted file (logs warn, skips)', async () => {
    const corruptedPath = path.join(dataDir, 'invoices', 'inv_corrupted.json');
    await fs.writeFile(corruptedPath, '{not valid json', 'utf8');
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const pending = await storage.listPendingInvoices();
      expect(pending.find((i) => i.id === 'inv_corrupted')).toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
  });

  it('listPendingInvoices excludes expired invoices', async () => {
    const merchant = await storage.getMerchant('any');
    await storage.createInvoice({
      id: 'inv_expired',
      merchant_id: merchant!.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.0001',
      address: 'bc1qexpired',
      child_index: 2,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    const pending = await storage.listPendingInvoices();
    expect(pending.find((i) => i.id === 'inv_expired')).toBeUndefined();
  });
});

describe('JsonFileStorage — concurrent nextChildIndex stress', () => {
  it('100 parallel calls return {0..99} with no duplicates', async () => {
    const dir = await makeTmpDir();
    const storage = new JsonFileStorage({ dataDir: dir });
    const merchant = await storage.createMerchant({
      shop_name: 'Stress Shop',
      email: 'stress@example.test',
      xpub: 'zpubStress',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:stress',
    });
    const calls = Array.from({ length: 100 }, () => storage.nextChildIndex(merchant.id));
    const indexes = await Promise.all(calls);
    const unique = new Set(indexes);
    expect(unique.size).toBe(100);
    expect(Math.min(...indexes)).toBe(0);
    expect(Math.max(...indexes)).toBe(99);
    const after = await storage.getMerchant(merchant.id);
    expect(after?.next_child_index).toBe(100);
  });
});
