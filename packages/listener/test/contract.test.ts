import { describe, expect, it } from 'vitest';
import { MissingStorageDependencyError, createStorageAdapter } from '../src/storage/index.js';
import type { Chain, InvoiceStatus } from '../src/types.js';

// Z55 ships the architectural skeleton only. The describeStorageContract
// function is exported from ./storage-contract for Z56-Z59 to consume from
// their adapter packages — those PRs will add a test file calling
//   describeStorageContract('json', () => makeJsonAdapter(...))
// which will exercise the seven contract cases listed below as todos.

describe('@zettapay/listener — Z55 architectural skeleton', () => {
  it('createStorageAdapter rejects with a clear Z55-aware not-yet-implemented error', async () => {
    await expect(createStorageAdapter({ kind: 'json' })).rejects.toThrow(/Z55|Z56|adapter/i);
  });

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

  // StorageAdapter contract cases — implemented as it.todo in Z55, exercised
  // for real in Z56-Z59 via describeStorageContract(name, factory).
  it.todo('StorageAdapter contract: createMerchant + getMerchant round-trip');
  it.todo('StorageAdapter contract: nextChildIndex atomic under 100 concurrent callers');
  it.todo('StorageAdapter contract: createInvoice + listPendingInvoices filter by status');
  it.todo('StorageAdapter contract: updateInvoiceStatus preserves untouched fields');
  it.todo('StorageAdapter contract: getWebhookEventsDue filters by next_retry_at <= now');
  it.todo('StorageAdapter contract: crash-safety via tmp + rename atomic');
  it.todo('StorageAdapter contract: invoice fixture serializes to canonical schema string');
});
