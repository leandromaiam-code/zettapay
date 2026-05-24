import { describe, expect, it } from 'vitest';
import { MissingStorageDependencyError, createStorageAdapter } from '../src/storage/index.js';
import type { Chain, InvoiceStatus, StorageKind } from '../src/types.js';

// Z56 lands JSON; Z59 lands SQLite. Supabase / Postgres still throw a clear
// not-yet-implemented error here. The full StorageAdapter contract is
// exercised per-adapter from ./<adapter>-storage.test.ts via
// describeStorageContract.

describe('@zettapay/listener — factory + types', () => {
  it('createStorageAdapter resolves a JSON adapter (Z56 default)', async () => {
    const adapter = await createStorageAdapter({ kind: 'json', dataDir: undefined });
    expect(adapter).toBeDefined();
    expect(typeof adapter.createMerchant).toBe('function');
    expect(typeof adapter.nextChildIndex).toBe('function');
  });

  it('createStorageAdapter resolves a SQLite adapter (Z59)', async () => {
    const adapter = await createStorageAdapter({ kind: 'sqlite', sqliteFilename: ':memory:' });
    expect(adapter).toBeDefined();
    expect(typeof adapter.createMerchant).toBe('function');
    expect(typeof adapter.nextChildIndex).toBe('function');
    if (adapter.close) await adapter.close();
  });

  it.each<StorageKind>(['supabase', 'postgres'])(
    'createStorageAdapter still rejects for %s (Z60+)',
    async (kind) => {
      await expect(createStorageAdapter({ kind })).rejects.toThrow(/Z60/);
    },
  );

  it('MissingStorageDependencyError carries kind + peer install hint', () => {
    const err = new MissingStorageDependencyError('sqlite', 'better-sqlite3');
    expect(err.message).toContain('better-sqlite3');
    expect(err.message).toContain('npm install');
    expect(err.kind).toBe('sqlite');
    expect(err.peer).toBe('better-sqlite3');
  });

  it('Chain + InvoiceStatus enums are the canonical set', () => {
    const chains: Chain[] = ['btc', 'polygon', 'eth'];
    const statuses: InvoiceStatus[] = ['pending', 'partial', 'confirmed', 'expired', 'failed'];
    expect(chains).toHaveLength(3);
    expect(statuses).toHaveLength(5);
  });
});
