import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  Invoice,
  InvoiceInput,
  Merchant,
  MerchantInput,
  WebhookEventInput,
} from '../src/types.js';
import type { StorageAdapter } from '../src/storage/index.js';

export interface StorageContractFactory {
  (): Promise<StorageAdapter>;
}

const FIXTURE_MERCHANT: MerchantInput = {
  shop_name: 'Acme Coffee',
  email: 'ops@example.test',
  xpub: 'zpub6jftahH18ngZxsSD8JbzmaToDHHcJhHYy9RLGfYoXTzg7TpQ6KCv4cZk3pP5Y7g3PFAKExampleOnly',
  webhook_url: 'https://example.test/webhooks/zettapay',
  webhook_secret_hash: 'sha256:placeholder',
};

function makeInvoiceFixture(merchantId: string, overrides: Partial<InvoiceInput> = {}): InvoiceInput {
  return {
    id: 'inv_test_001',
    merchant_id: merchantId,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.00050000',
    address: 'bc1qexampleaddressdoesnotresolvetoanyutxo',
    child_index: 0,
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function makeWebhookEventFixture(invoiceId: string): WebhookEventInput {
  return {
    id: 'evt_test_001',
    invoice_id: invoiceId,
    payload_json: JSON.stringify({ event: 'invoice.paid', invoice_id: invoiceId }),
    next_retry_at: new Date(Date.now() - 1000).toISOString(),
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

/**
 * Conformance suite every StorageAdapter implementation must pass.
 *
 * Usage from an adapter package or test file:
 *
 *   import { describeStorageContract } from '@zettapay/listener/test/storage-contract';
 *   describeStorageContract('json', () => makeJsonAdapter({ dataDir: tmpdir() }));
 *
 * Z55 ships the suite as `it.todo` stubs — concrete adapters land in Z56-Z59.
 */
export function describeStorageContract(
  name: string,
  factory: StorageContractFactory,
): void {
  describe(`StorageAdapter contract: ${name}`, () => {
    let adapter: StorageAdapter;
    let merchant: Merchant;

    beforeEach(async () => {
      adapter = await factory();
      merchant = await adapter.createMerchant(FIXTURE_MERCHANT);
    });

    afterEach(async () => {
      if (adapter?.close) await adapter.close();
    });

    it('createMerchant + getMerchant round-trip preserves all fields', async () => {
      const fetched = await adapter.getMerchant(merchant.id);
      expect(fetched).not.toBeNull();
      expect(fetched).toMatchObject(FIXTURE_MERCHANT);
      expect(fetched?.id).toBe(merchant.id);
      expect(typeof fetched?.next_child_index).toBe('number');
      expect(typeof fetched?.created_at).toBe('string');
    });

    it('nextChildIndex is atomic under concurrent callers (100 distinct indexes)', async () => {
      const calls = Array.from({ length: 100 }, () => adapter.nextChildIndex(merchant.id));
      const indexes = await Promise.all(calls);
      const unique = new Set(indexes);
      expect(unique.size).toBe(100);
      const sorted = [...indexes].sort((a, b) => a - b);
      expect(sorted[0]).toBeGreaterThanOrEqual(0);
      expect(sorted[sorted.length - 1] - sorted[0]).toBe(99);
    });

    it('createInvoice + getInvoice + listPendingInvoices filters by status', async () => {
      const created = await adapter.createInvoice(makeInvoiceFixture(merchant.id));
      const fetched = await adapter.getInvoice(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.status).toBe('pending');

      const pending = await adapter.listPendingInvoices();
      expect(pending.find((i) => i.id === created.id)).toBeDefined();

      await adapter.updateInvoiceStatus(created.id, 'confirmed');
      const afterConfirm = await adapter.listPendingInvoices();
      expect(afterConfirm.find((i) => i.id === created.id)).toBeUndefined();
    });

    it('updateInvoiceStatus preserves untouched fields (snapshot invariant)', async () => {
      const input = makeInvoiceFixture(merchant.id, { id: 'inv_test_snapshot' });
      const created = await adapter.createInvoice(input);
      const before: Invoice = { ...created };

      const updated = await adapter.updateInvoiceStatus(created.id, 'confirmed', {
        tx_hash: '0xabc',
        paid_at: new Date().toISOString(),
      });

      expect(updated.status).toBe('confirmed');
      expect(updated.tx_hash).toBe('0xabc');
      expect(updated.paid_at).not.toBeNull();
      // every field other than status/tx_hash/paid_at/updated_at must match
      for (const key of [
        'id',
        'merchant_id',
        'chain',
        'asset',
        'amount',
        'address',
        'child_index',
        'expires_at',
        'created_at',
      ] as const) {
        expect(updated[key]).toEqual(before[key]);
      }
    });

    it('recordWebhookEvent + getWebhookEventsDue filters by next_retry_at <= now', async () => {
      const invoice = await adapter.createInvoice(makeInvoiceFixture(merchant.id, { id: 'inv_for_evt' }));
      const evt = await adapter.recordWebhookEvent(makeWebhookEventFixture(invoice.id));
      expect(evt.attempts).toBe(0);

      const due = await adapter.getWebhookEventsDue(new Date(), 10);
      expect(due.find((e) => e.id === evt.id)).toBeDefined();

      const past = new Date(Date.now() - 10_000);
      const empty = await adapter.getWebhookEventsDue(past, 10);
      expect(empty.find((e) => e.id === evt.id)).toBeUndefined();

      await adapter.markWebhookDelivered(evt.id, { ok: true, statusCode: 200 });
      const afterDelivery = await adapter.getWebhookEventsDue(new Date(), 10);
      expect(afterDelivery.find((e) => e.id === evt.id)).toBeUndefined();
    });

    it.todo('crash-safety: simulated kill during write leaves file system consistent (tmp + rename atomic)');

    it('invoice fixture serializes to a canonical string (schema-drift detector)', async () => {
      const created = await adapter.createInvoice(makeInvoiceFixture(merchant.id, { id: 'inv_snapshot_schema' }));
      // strip volatile timestamps + optional production-only passthrough
      // fields (Z57 — receive_address / amount_usd / confirmations / metadata)
      // so the snapshot remains a stable schema-drift detector across adapters
      const {
        created_at: _c,
        updated_at: _u,
        expires_at: _e,
        receive_address: _ra,
        amount_usd: _au,
        amount_btc: _ab,
        required_confirmations: _rc,
        confirmations: _cf,
        detected_at: _da,
        confirmed_at: _ca,
        metadata: _md,
        ...stable
      } = created;
      const canonical = canonicalJson(stable);
      const expected =
        '{"address":"bc1qexampleaddressdoesnotresolvetoanyutxo",' +
        '"amount":"0.00050000",' +
        '"asset":"BTC",' +
        '"chain":"btc",' +
        '"child_index":0,' +
        '"id":"inv_snapshot_schema",' +
        `"merchant_id":${JSON.stringify(merchant.id)},` +
        '"paid_at":null,' +
        '"status":"pending",' +
        '"tx_hash":null}';
      expect(canonical).toBe(expected);
    });
  });
}
