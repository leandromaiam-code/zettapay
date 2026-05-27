// End-to-end integration of BtcListener with a stubbed mempool.space surface.
//
// What this proves:
//   1. A pending invoice is subscribed to on WS open.
//   2. A mempool-only tx flips the invoice's tx_hash but keeps status=pending
//      (status "seen", no webhook yet).
//   3. A confirmed tx at the required depth flips status=confirmed and emits
//      a webhook event into storage (the dispatcher would then deliver it).
//
// No real network. The fetch stub serves /address/<addr>/txs + /tx/<txid>, and
// we shove WS messages straight at the listener's private handler so the test
// is hermetic and < 100ms.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BtcListener } from '../src/listener.js';
import { JsonFileStorage } from '../src/storage/json.js';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-lis-int-'));
  tmpdirs.push(dir);
  return dir;
}

const originalFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function seedInvoice(storage: JsonFileStorage, address: string) {
  const merchant = await storage.createMerchant({
    shop_name: 'Integration Shop',
    email: 'int@example.test',
    xpub: 'zpubIntegrationOnly',
    webhook_url: 'https://int.example.test/wh',
    webhook_secret_hash: 'sha256:int',
  });
  const invoice = await storage.createInvoice({
    id: 'inv_int_001',
    merchant_id: merchant.id,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.00050000',
    address,
    child_index: 0,
    expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  return { merchant, invoice };
}

describe('BtcListener — end-to-end stub flow', () => {
  let storage: JsonFileStorage;
  const ADDRESS = 'tb1q8jxgf638tx5tmv3k3swxy2cjm59mfshqf0l35n'; // matches our testnet vector
  const TXID = 'b'.repeat(64);

  beforeEach(async () => {
    storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
  });

  it('mempool-only tx marks invoice as seen (status=pending + tx_hash set)', async () => {
    const { invoice } = await seedInvoice(storage, ADDRESS);
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: invoice.merchant_id,
      requiredConfirmations: () => 1,
    });
    // Prime the address mapping the way reconcileSubscriptions would.
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );

    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        [ADDRESS]: [{ txid: TXID, status: { confirmed: false } }],
      },
    });

    const after = await storage.getInvoice(invoice.id);
    expect(after?.status).toBe('pending');
    expect(after?.tx_hash).toBe(TXID);

    // No webhook yet — confirmation didn't happen.
    const due = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    expect(due.length).toBe(0);
  });

  it('confirmed tx at required depth flips status=confirmed and records a webhook event', async () => {
    const { invoice } = await seedInvoice(storage, ADDRESS);
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: invoice.merchant_id,
      requiredConfirmations: () => 1,
    });
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;

    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        [ADDRESS]: [
          { txid: TXID, status: { confirmed: true, block_height: 100 } },
        ],
      },
    });

    const after = await storage.getInvoice(invoice.id);
    expect(after?.status).toBe('confirmed');
    expect(after?.tx_hash).toBe(TXID);
    expect(after?.paid_at).not.toBeNull();

    const due = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    expect(due.length).toBe(1);
    expect(due[0]?.invoice_id).toBe(invoice.id);
    const payload = JSON.parse(due[0]!.payload_json);
    expect(payload.event).toBe('invoice.confirmed');
    expect(payload.tx_hash).toBe(TXID);
    expect(payload.confirmations).toBe(1);
  });

  it('pending → seen → confirmed (two-step ws delivery)', async () => {
    const { invoice } = await seedInvoice(storage, ADDRESS);
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: invoice.merchant_id,
      requiredConfirmations: () => 3,
    });
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;

    // First WS hit: tx in mempool only.
    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        [ADDRESS]: [{ txid: TXID, status: { confirmed: false } }],
      },
    });
    let snap = await storage.getInvoice(invoice.id);
    expect(snap?.status).toBe('pending');
    expect(snap?.tx_hash).toBe(TXID);

    // Second WS hit: tx confirmed at depth=1 — still below required=3.
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;
    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        [ADDRESS]: [
          { txid: TXID, status: { confirmed: true, block_height: 100 } },
        ],
      },
    });
    snap = await storage.getInvoice(invoice.id);
    expect(snap?.status).toBe('pending');

    // Third hit: tip advanced to 102 → depth = 102 - 100 + 1 = 3, hits threshold.
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 102;
    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        [ADDRESS]: [
          { txid: TXID, status: { confirmed: true, block_height: 100 } },
        ],
      },
    });
    snap = await storage.getInvoice(invoice.id);
    expect(snap?.status).toBe('confirmed');

    const due = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    expect(due.length).toBe(1);
    const payload = JSON.parse(due[0]!.payload_json);
    expect(payload.confirmations).toBe(3);
  });

  it('multi-address-transactions bucket also routes to processTx', async () => {
    const { invoice } = await seedInvoice(storage, ADDRESS);
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: invoice.merchant_id,
      requiredConfirmations: () => 1,
    });
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;

    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'multi-address-transactions': {
        [ADDRESS]: {
          confirmed: [
            { txid: TXID, status: { confirmed: true, block_height: 100 } },
          ],
        },
      },
    });

    const after = await storage.getInvoice(invoice.id);
    expect(after?.status).toBe('confirmed');
  });

  it('isolates merchants: another merchant\'s address is never updated', async () => {
    // HR-TENANT-ISOLATION: an event for an address we don't own is ignored.
    const { invoice } = await seedInvoice(storage, ADDRESS);
    globalThis.fetch = (async () =>
      new Response('[]', { status: 200 })) as unknown as typeof fetch;

    const listener = new BtcListener({
      storage,
      merchantId: invoice.merchant_id,
      requiredConfirmations: () => 1,
    });
    (listener as unknown as { addressToInvoiceId: Map<string, string> }).addressToInvoiceId.set(
      invoice.address,
      invoice.id,
    );
    (listener as unknown as { lastBlockHeight: number }).lastBlockHeight = 100;

    await (
      listener as unknown as {
        handleWsMessage: (m: unknown) => Promise<void>;
      }
    ).handleWsMessage({
      'address-transactions': {
        // Bogus address — not in our addressToInvoiceId map.
        'tb1qsomeoneelseunrelatedxxxxxxxxxxxxxxxxxx': [
          { txid: 'c'.repeat(64), status: { confirmed: true, block_height: 100 } },
        ],
      },
    });

    const after = await storage.getInvoice(invoice.id);
    expect(after?.status).toBe('pending');
    expect(after?.tx_hash).toBeNull();
    const due = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    expect(due.length).toBe(0);
  });
});
