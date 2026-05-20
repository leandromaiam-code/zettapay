import { describe, expect, it } from 'vitest';
import {
  MissingStorageDependencyError,
  StorageConfigError,
  createStorageAdapter,
} from '../src/storage/index.js';
import type { Chain, InvoiceStatus, StorageKind } from '../src/types.js';

// Z56 landed the JSON adapter; Z57 added the Supabase adapter (fetch REST,
// no Supabase JS SDK peer dep). SQLite + Postgres are still on the roadmap
// and continue to throw a clear not-yet-implemented error here.

describe('@zettapay/listener — factory + types', () => {
  it('createStorageAdapter resolves a JSON adapter (Z56 default)', async () => {
    const adapter = await createStorageAdapter({ kind: 'json', dataDir: undefined });
    expect(adapter).toBeDefined();
    expect(typeof adapter.createMerchant).toBe('function');
    expect(typeof adapter.nextChildIndex).toBe('function');
  });

  it('createStorageAdapter resolves a Supabase adapter when credentials are present (Z57)', async () => {
    const adapter = await createStorageAdapter({
      kind: 'supabase',
      supabaseUrl: 'https://example.supabase.co',
      supabaseServiceRoleKey: 'sb-test-key',
    });
    expect(adapter).toBeDefined();
    expect(typeof adapter.findInvoiceByAddress).toBe('function');
    expect(typeof adapter.getMerchantByEmail).toBe('function');
  });

  it('createStorageAdapter rejects supabase without credentials', async () => {
    await expect(createStorageAdapter({ kind: 'supabase' })).rejects.toBeInstanceOf(
      StorageConfigError,
    );
  });

  it.each<StorageKind>(['sqlite', 'postgres'])(
    'createStorageAdapter still rejects for %s (Z58+)',
    async (kind) => {
      await expect(createStorageAdapter({ kind })).rejects.toThrow(/Z58/);
    },
  );

  it('MissingStorageDependencyError carries kind + peer install hint', () => {
    const err = new MissingStorageDependencyError('sqlite', 'better-sqlite3');
    expect(err.message).toContain('better-sqlite3');
    expect(err.message).toContain('npm install');
    expect(err.kind).toBe('sqlite');
    expect(err.peer).toBe('better-sqlite3');
  });

  it('Chain + InvoiceStatus enums cover the canonical statuses', () => {
    const chains: Chain[] = ['btc', 'polygon', 'eth'];
    const statuses: InvoiceStatus[] = [
      'pending',
      'partial',
      'detected',
      'confirmed',
      'expired',
      'failed',
    ];
    expect(chains).toHaveLength(3);
    expect(statuses).toHaveLength(6);
  });
});
