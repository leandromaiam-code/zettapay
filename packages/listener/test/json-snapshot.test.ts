import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JsonFileStorage } from '../src/storage/json.js';

const FROZEN_NOW = new Date('2026-05-18T12:00:00.000Z');
const FROZEN_EXPIRES = new Date('2026-05-18T13:00:00.000Z').toISOString();

describe('JsonFileStorage — on-disk file shape (snapshot)', () => {
  let dataDir: string;
  let storage: JsonFileStorage;

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-json-snap-'));
    storage = new JsonFileStorage({ dataDir });
  });

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(FROZEN_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('invoice file matches canonical schema and pretty-printed JSON', async () => {
    const merchant = await storage.createMerchant({
      shop_name: 'Snapshot Shop',
      email: 'snap@example.test',
      xpub: 'zpubSnapshotFixed',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:snap',
    });

    const invoice = await storage.createInvoice({
      id: 'inv_snapshot_fixed',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.00050000',
      address: 'bc1qsnapshotaddressexampleonly',
      child_index: 0,
      expires_at: FROZEN_EXPIRES,
    });

    const filePath = path.join(dataDir, 'invoices', 'inv_snapshot_fixed.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    expect(parsed).toEqual({
      id: 'inv_snapshot_fixed',
      merchant_id: merchant.id,
      chain: 'btc',
      asset: 'BTC',
      amount: '0.00050000',
      address: 'bc1qsnapshotaddressexampleonly',
      child_index: 0,
      status: 'pending',
      expires_at: FROZEN_EXPIRES,
      paid_at: null,
      tx_hash: null,
      created_at: FROZEN_NOW.toISOString(),
      updated_at: FROZEN_NOW.toISOString(),
    });
    expect(invoice).toEqual(parsed);
    // pretty-printed, two-space indent
    expect(raw.startsWith('{\n  "id":')).toBe(true);
  });

  it('merchant file matches canonical schema and pretty-printed JSON', async () => {
    const merchantFile = path.join(dataDir, 'merchant.json');
    const raw = await fs.readFile(merchantFile, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      shop_name: 'Snapshot Shop',
      email: 'snap@example.test',
      xpub: 'zpubSnapshotFixed',
      webhook_url: 'https://example.test/webhook',
      webhook_secret_hash: 'sha256:snap',
      next_child_index: 0,
      created_at: FROZEN_NOW.toISOString(),
    });
    expect(typeof parsed.id).toBe('string');
    expect(raw.startsWith('{\n  "id":')).toBe(true);
  });

  it('webhook event file matches canonical schema', async () => {
    const merchant = await storage.getMerchant('any');
    const evt = await storage.recordWebhookEvent({
      id: 'evt_snapshot_fixed',
      invoice_id: 'inv_snapshot_fixed',
      payload_json: '{"event":"invoice.paid"}',
      next_retry_at: FROZEN_NOW.toISOString(),
    });
    expect(evt.attempts).toBe(0);
    const filePath = path.join(dataDir, 'webhook_events', 'evt_snapshot_fixed.json');
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toEqual({
      id: 'evt_snapshot_fixed',
      invoice_id: 'inv_snapshot_fixed',
      payload_json: '{"event":"invoice.paid"}',
      attempts: 0,
      next_retry_at: FROZEN_NOW.toISOString(),
      delivered_at: null,
      last_status_code: null,
      last_error: null,
    });
    expect(merchant).not.toBeNull();
  });
});
