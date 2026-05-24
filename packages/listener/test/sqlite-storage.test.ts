import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { InvoiceNotFoundError, MerchantNotInitializedError } from '../src/errors.js';
import { MissingStorageDependencyError } from '../src/types.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { describeStorageContract } from './storage-contract.js';

const require_ = createRequire(import.meta.url);
let BetterSqlite3: (new (filename: string, opts?: object) => {
  prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown };
  close: () => void;
}) | null = null;
try {
  const mod = require_('better-sqlite3');
  BetterSqlite3 = mod.default ?? mod;
} catch {
  BetterSqlite3 = null;
}

const adapters: SqliteStorage[] = [];

if (BetterSqlite3) {
  describeStorageContract('sqlite', async () => {
    const adapter = new SqliteStorage({ filename: ':memory:' });
    adapters.push(adapter);
    return adapter;
  });
}

afterAll(async () => {
  await Promise.all(adapters.map((a) => a.close()));
});

const adapterSuite = BetterSqlite3 ? describe : describe.skip;

adapterSuite('SqliteStorage — adapter-specific behaviors', () => {
  it('schema columns match the canonical migration contract', async () => {
    const Driver = BetterSqlite3!;
    const db = new Driver(':memory:');
    const adapter = new SqliteStorage({ database: db });
    adapters.push(adapter);
    await adapter.init();

    const colNames = (table: string): string[] =>
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
        .map((c) => c.name)
        .sort();

    expect(colNames('merchants')).toEqual(
      [
        'id',
        'shop_name',
        'email',
        'xpub',
        'webhook_url',
        'webhook_secret_hash',
        'next_child_index',
        'created_at',
      ].sort(),
    );
    expect(colNames('invoices')).toEqual(
      [
        'id',
        'merchant_id',
        'chain',
        'asset',
        'amount',
        'address',
        'child_index',
        'status',
        'expires_at',
        'paid_at',
        'tx_hash',
        'created_at',
        'updated_at',
      ].sort(),
    );
    expect(colNames('webhook_events')).toEqual(
      [
        'id',
        'invoice_id',
        'payload_json',
        'attempts',
        'next_retry_at',
        'delivered_at',
        'last_status_code',
        'last_error',
      ].sort(),
    );
  });

  it('nextChildIndex throws MerchantNotInitializedError when no merchant', async () => {
    const adapter = new SqliteStorage({ filename: ':memory:' });
    adapters.push(adapter);
    await adapter.init();
    await expect(adapter.nextChildIndex('any')).rejects.toBeInstanceOf(MerchantNotInitializedError);
  });

  it('updateInvoiceStatus throws InvoiceNotFoundError for unknown id', async () => {
    const adapter = new SqliteStorage({ filename: ':memory:' });
    adapters.push(adapter);
    await adapter.createMerchant({
      shop_name: 'X',
      email: 'x@example.test',
      xpub: 'zpubX',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:x',
    });
    await expect(adapter.updateInvoiceStatus('inv_unknown', 'confirmed')).rejects.toBeInstanceOf(
      InvoiceNotFoundError,
    );
  });

  it('listPendingInvoices excludes expired and confirmed invoices', async () => {
    const adapter = new SqliteStorage({ filename: ':memory:' });
    adapters.push(adapter);
    const merchant = await adapter.createMerchant({
      shop_name: 'P',
      email: 'p@example.test',
      xpub: 'zpubP',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:p',
    });
    await adapter.createInvoice({
      id: 'inv_expired',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.0001',
      address: 'bc1qexpired',
      child_index: 0,
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await adapter.createInvoice({
      id: 'inv_live',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.0002',
      address: 'bc1qlive',
      child_index: 1,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const pending = await adapter.listPendingInvoices();
    expect(pending.find((i) => i.id === 'inv_expired')).toBeUndefined();
    expect(pending.find((i) => i.id === 'inv_live')).toBeDefined();
  });

  it('createMerchant is idempotent — second call returns existing row', async () => {
    const adapter = new SqliteStorage({ filename: ':memory:' });
    adapters.push(adapter);
    const a = await adapter.createMerchant({
      shop_name: 'First',
      email: 'first@example.test',
      xpub: 'zpubFirst',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:first',
    });
    const b = await adapter.createMerchant({
      shop_name: 'Should Not Apply',
      email: 'other@example.test',
      xpub: 'zpubOther',
      webhook_url: 'https://example.test/other',
      webhook_secret_hash: 'sha256:other',
    });
    expect(b.id).toBe(a.id);
    expect(b.shop_name).toBe('First');
  });
});

describe('SqliteStorage — driver loading', () => {
  it('throws MissingStorageDependencyError when driver loader fails', async () => {
    const adapter = new SqliteStorage({
      filename: ':memory:',
      driver: new Proxy(function () {} as unknown as new () => never, {
        construct() {
          throw new MissingStorageDependencyError('sqlite', 'better-sqlite3');
        },
      }) as unknown as new (filename: string) => never,
    });
    await expect(adapter.init()).rejects.toBeInstanceOf(MissingStorageDependencyError);
  });
});
