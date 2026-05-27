// Cross-adapter atomicity regression. The two failure modes we want to lock
// against are:
//
//   1. Index dog-pile: many parallel `nextChildIndex` calls return the SAME
//      counter value, which leaks a duplicate child path and burns the next
//      address on a race. Json + Sqlite are tested side-by-side so it's hard
//      to merge an adapter that quietly broke this invariant.
//
//   2. Crash mid-write: a tmp file from a prior crashed writer is left behind
//      in the data dir. The next listener boot must NOT confuse that tmp file
//      with a real invoice / webhook record. Json uses `<file>.tmp.<pid>.<uuid>`
//      and renames-only-on-success; we assert the recovery contract here.

import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileStorage } from '../src/storage/json.js';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { StorageCorruptionError } from '../src/errors.js';

const require_ = createRequire(import.meta.url);
let hasBetterSqlite = false;
try {
  require_('better-sqlite3');
  hasBetterSqlite = true;
} catch {
  hasBetterSqlite = false;
}

const tmpdirs: string[] = [];
const adapters: Array<{ close?: () => Promise<void> }> = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-atom-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(async (a) => a.close?.()));
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('JsonFileStorage — atomic nextChildIndex under high parallelism', () => {
  it('500 parallel allocations return {0..499} with zero duplicates', async () => {
    const dir = await makeTmpDir();
    const storage = new JsonFileStorage({ dataDir: dir });
    adapters.push(storage);
    const merchant = await storage.createMerchant({
      shop_name: 'Atom Json',
      email: 'aj@example.test',
      xpub: 'zpubAtomJson',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:aj',
    });
    const calls = Array.from({ length: 500 }, () => storage.nextChildIndex(merchant.id));
    const indexes = await Promise.all(calls);
    const unique = new Set(indexes);
    expect(unique.size).toBe(500);
    expect(Math.min(...indexes)).toBe(0);
    expect(Math.max(...indexes)).toBe(499);
    const after = await storage.getMerchant(merchant.id);
    expect(after?.next_child_index).toBe(500);
  });

  it('createInvoice atomic write leaves no stray .tmp files behind', async () => {
    const dir = await makeTmpDir();
    const storage = new JsonFileStorage({ dataDir: dir });
    adapters.push(storage);
    const merchant = await storage.createMerchant({
      shop_name: 'Atom Tmp',
      email: 'tmp@example.test',
      xpub: 'zpubAtomTmp',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:tmp',
    });
    await Promise.all(
      Array.from({ length: 25 }, (_, i) =>
        storage.createInvoice({
          id: `inv_tmp_${i}`,
          merchant_id: merchant.id,
          chain: 'btc',
          asset: 'BTC',
          amount: '0.00001',
          address: `bc1qatomtmp${i}`,
          child_index: i,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      ),
    );
    const invDir = path.join(dir, 'invoices');
    const entries = await fs.readdir(invDir);
    const strays = entries.filter((e) => e.includes('.tmp.'));
    expect(strays).toEqual([]);
    // Sanity: all 25 records are visible
    expect(entries.filter((e) => e.startsWith('inv_tmp_') && e.endsWith('.json'))).toHaveLength(25);
  });

  it('crash mid-write recovery: stray .tmp from a prior crash is ignored', async () => {
    // Simulate a crashed writer by hand-dropping a partial tmp file into the
    // invoices/ dir. listPendingInvoices must skip it (the JSON parse will
    // fail; the corrupted-file branch logs a warning + continues). Critically
    // the next createInvoice must still succeed.
    const dir = await makeTmpDir();
    const storage = new JsonFileStorage({ dataDir: dir });
    adapters.push(storage);
    const merchant = await storage.createMerchant({
      shop_name: 'Crash',
      email: 'crash@example.test',
      xpub: 'zpubCrash',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:crash',
    });
    const invDir = path.join(dir, 'invoices');
    const strayTmp = path.join(invDir, `.inv_partial.json.tmp.${process.pid}.deadbeef`);
    await fs.writeFile(strayTmp, '{not-finished-json', 'utf8');

    // Listing should still work — stray files starting with `.` are ignored.
    const pending = await storage.listPendingInvoices();
    expect(pending).toEqual([]);

    // Fresh write must still land cleanly.
    const inv = await storage.createInvoice({
      id: 'inv_after_crash',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.00001',
      address: 'bc1qaftercrash',
      child_index: 0,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(inv.id).toBe('inv_after_crash');
    // And the partial tmp is still on disk untouched (operator can sweep it).
    await expect(fs.access(strayTmp)).resolves.toBeUndefined();
  });

  it('explicitly corrupted JSON throws StorageCorruptionError on direct read', async () => {
    // The tighter contract: if a real, named record file (not a tmp) gets
    // truncated, reading it directly surfaces the StorageCorruptionError
    // instead of silently returning null + corrupting downstream state.
    const dir = await makeTmpDir();
    const storage = new JsonFileStorage({ dataDir: dir });
    adapters.push(storage);
    await storage.createMerchant({
      shop_name: 'Corrupt',
      email: 'corrupt@example.test',
      xpub: 'zpubCorrupt',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:corrupt',
    });
    const badPath = path.join(dir, 'invoices', 'inv_broken.json');
    await fs.writeFile(badPath, '{"not-finished":', 'utf8');
    await expect(storage.getInvoice('inv_broken')).rejects.toBeInstanceOf(
      StorageCorruptionError,
    );
  });
});

const sqliteSuite = hasBetterSqlite ? describe : describe.skip;

sqliteSuite('SqliteStorage — atomic nextChildIndex under high parallelism', () => {
  it('500 parallel allocations return {0..499} with zero duplicates', async () => {
    const storage = new SqliteStorage({ filename: ':memory:' });
    adapters.push(storage);
    const merchant = await storage.createMerchant({
      shop_name: 'Atom Sqlite',
      email: 'as@example.test',
      xpub: 'zpubAtomSqlite',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:as',
    });
    const calls = Array.from({ length: 500 }, () => storage.nextChildIndex(merchant.id));
    const indexes = await Promise.all(calls);
    const unique = new Set(indexes);
    expect(unique.size).toBe(500);
    expect(Math.min(...indexes)).toBe(0);
    expect(Math.max(...indexes)).toBe(499);
    const after = await storage.getMerchant(merchant.id);
    expect(after?.next_child_index).toBe(500);
  });

  it('cross-adapter round-trip: json export → sqlite import preserves merchant.next_child_index', async () => {
    // Z60 ships BulkPortable. If sqlite imports a json snapshot that already
    // burned 17 indices, the next allocation must continue from 17, not 0.
    const dir = await makeTmpDir();
    const src = new JsonFileStorage({ dataDir: dir });
    adapters.push(src);
    const merchant = await src.createMerchant({
      shop_name: 'Round',
      email: 'r@example.test',
      xpub: 'zpubRound',
      webhook_url: 'https://example.test/wh',
      webhook_secret_hash: 'sha256:r',
    });
    for (let i = 0; i < 17; i += 1) await src.nextChildIndex(merchant.id);
    const dump = await src.exportAll();
    expect(dump.merchant?.next_child_index).toBe(17);

    const dst = new SqliteStorage({ filename: ':memory:' });
    adapters.push(dst);
    await dst.importBulk({
      merchant: dump.merchant ?? undefined,
      invoices: dump.invoices,
      webhookEvents: dump.webhookEvents,
    });
    const after = await dst.getMerchant(merchant.id);
    expect(after?.next_child_index).toBe(17);
    // And the next allocation continues the sequence — no reset.
    const next = await dst.nextChildIndex(merchant.id);
    expect(next).toBe(17);
  });
});
