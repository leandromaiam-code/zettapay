// Smoke tests for BtcListener — exercise lifecycle paths without ever
// reaching out to mempool.space. Network I/O is contained behind a per-test
// fetch stub so the suite is hermetic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BtcListener } from '../src/listener.js';
import { JsonFileStorage } from '../src/storage/json.js';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-listener-'));
  tmpdirs.push(dir);
  return dir;
}

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function seedMerchantAndInvoice(storage: JsonFileStorage) {
  const merchant = await storage.createMerchant({
    shop_name: 'Listener Test',
    email: 'l@example.test',
    xpub: 'zpubListenerTest',
    webhook_url: 'https://example.test/wh',
    webhook_secret_hash: 'sha256:placeholder',
  });
  const invoice = await storage.createInvoice({
    id: 'inv_listener_001',
    merchant_id: merchant.id,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.00010000',
    address: 'bc1qlistenertestaddrxxxxxxxxxxxxxxx',
    child_index: 0,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  return { merchant, invoice };
}

describe('BtcListener', () => {
  let storage: JsonFileStorage;

  beforeEach(async () => {
    storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
  });

  it('status() returns initial snapshot before start()', () => {
    const listener = new BtcListener({ storage, merchantId: 'm_unused' });
    const s = listener.status();
    expect(s).toMatchObject({
      wsConnected: false,
      subscribedCount: 0,
      lastEventAt: null,
      lastBlockHeight: null,
    });
    expect(typeof s.uptimeSeconds).toBe('number');
  });

  it('exposes status() before any network activity', () => {
    const listener = new BtcListener({ storage, merchantId: 'm_unused' });
    expect(listener.status().wsConnected).toBe(false);
  });

  it('stop() is a no-op when never started', async () => {
    const listener = new BtcListener({ storage, merchantId: 'm_unused' });
    await expect(listener.stop()).resolves.toBeUndefined();
  });

  it('backfill calls REST GET /address/<addr>/txs for each pending invoice', async () => {
    const { invoice } = await seedMerchantAndInvoice(storage);
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: 'm_unused',
      restBase: 'https://mempool.space/api',
    });
    // call private via type assertion to avoid wiring real WS
    await (listener as unknown as { backfillPending: () => Promise<void> }).backfillPending();
    expect(calls.length).toBe(1);
    expect(calls[0]).toBe(`https://mempool.space/api/address/${encodeURIComponent(invoice.address)}/txs`);
  });

  it('processTx flips an invoice to confirmed and records a webhook event when confs >= required', async () => {
    const { invoice } = await seedMerchantAndInvoice(storage);
    const listener = new BtcListener({
      storage,
      merchantId: 'm_unused',
      requiredConfirmations: () => 1,
    });
    // hydrate the in-memory address → invoice mapping
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    // fake "tip height = 100, tx in 100" -> 1 confirmation
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;
    await (listener as unknown as {
      processTx: (addr: string, tx: unknown) => Promise<void>;
    }).processTx(invoice.address, {
      txid: 'a'.repeat(64),
      status: { confirmed: true, block_height: 100 },
    });

    const after = await storage.getInvoice(invoice.id);
    expect(after?.status).toBe('confirmed');
    expect(after?.tx_hash).toBe('a'.repeat(64));
    expect(after?.paid_at).not.toBeNull();

    const events = await storage.getWebhookEventsDue(new Date(Date.now() + 5_000), 10);
    expect(events.length).toBe(1);
    expect(events[0]?.invoice_id).toBe(invoice.id);
  });
});
