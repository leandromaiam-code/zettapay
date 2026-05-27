import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileStorage } from '../src/storage/json.js';
import {
  MAX_ATTEMPTS,
  RETRY_CURVE_MS,
  WebhookDispatcher,
  nextRetryDate,
} from '../src/webhook-dispatcher.js';

const tmpdirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-wd-'));
  tmpdirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function seedDueEvent(storage: JsonFileStorage, payload: object) {
  const merchant = await storage.createMerchant({
    shop_name: 'WD Test',
    email: 'wd@example.test',
    xpub: 'zpubExampleWd',
    webhook_url: 'https://example.test/wh',
    webhook_secret_hash: 'sha256:wd',
  });
  const invoice = await storage.createInvoice({
    id: 'inv_wd_001',
    merchant_id: merchant.id,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.001',
    address: 'bc1qwdtest',
    child_index: 0,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  const event = await storage.recordWebhookEvent({
    id: 'evt_wd_001',
    invoice_id: invoice.id,
    payload_json: JSON.stringify(payload),
    next_retry_at: new Date(Date.now() - 1000).toISOString(),
  });
  return { merchant, invoice, event };
}

describe('WebhookDispatcher', () => {
  it('rejects non-https webhook URLs at construction', async () => {
    const storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
    expect(() =>
      new WebhookDispatcher({
        storage,
        webhookUrl: 'http://insecure.example.test/wh',
        webhookSecret: 'whsec_test',
      }),
    ).toThrow(/https/);
  });

  it('allows http://localhost as a documented dev exception', async () => {
    const storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
    const warnings: Array<{ msg: string; meta?: unknown }> = [];
    expect(() =>
      new WebhookDispatcher({
        storage,
        webhookUrl: 'http://localhost:9876/webhook',
        webhookSecret: 'whsec_test',
        logger: {
          info: () => {},
          warn: (msg, meta) => warnings.push({ msg, meta }),
          error: () => {},
        },
      }),
    ).not.toThrow();
    expect(warnings[0]?.msg).toBe('webhook_dispatcher.dev_mode_http');
  });

  it('allows http://127.0.0.1 as a documented dev exception', async () => {
    const storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
    expect(() =>
      new WebhookDispatcher({
        storage,
        webhookUrl: 'http://127.0.0.1:9876/webhook',
        webhookSecret: 'whsec_test',
      }),
    ).not.toThrow();
  });

  it('POSTs payload with HMAC-SHA256 of raw body in X-ZettaPay-Signature', async () => {
    const storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
    const payload = { event: 'invoice.confirmed', invoice_id: 'inv_wd_001' };
    const { event } = await seedDueEvent(storage, payload);

    const secret = 'whsec_signature_test';
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      captured = {
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: String(init?.body),
      };
      return new Response('', { status: 200 });
    }) as unknown as typeof fetch;

    const dispatcher = new WebhookDispatcher({
      storage,
      webhookUrl: 'https://merchant.example.test/wh',
      webhookSecret: secret,
      fetchImpl: fakeFetch,
    });

    await dispatcher.tick();

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe('https://merchant.example.test/wh');
    const expected = createHmac('sha256', secret).update(event.payload_json).digest('hex');
    expect(captured!.headers['X-ZettaPay-Signature']).toBe(expected);
    expect(captured!.headers['X-ZettaPay-Event-Id']).toBe(event.id);
    expect(captured!.headers['X-ZettaPay-Attempt']).toBe('1');
    expect(typeof captured!.headers['X-ZettaPay-Timestamp']).toBe('string');
    expect(captured!.body).toBe(event.payload_json);

    const stored = await storage.getWebhookEventsDue(new Date(Date.now() + 10), 10);
    expect(stored.find((e) => e.id === event.id)).toBeUndefined();
  });

  it('records failure + schedules retry on 5xx response', async () => {
    const storage = new JsonFileStorage({ dataDir: await makeTmpDir() });
    const { event } = await seedDueEvent(storage, { event: 'invoice.confirmed' });
    const fakeFetch: typeof fetch = (async () =>
      new Response('', { status: 503 })) as unknown as typeof fetch;

    const dispatcher = new WebhookDispatcher({
      storage,
      webhookUrl: 'https://merchant.example.test/wh',
      webhookSecret: 'whsec_test',
      fetchImpl: fakeFetch,
    });
    await dispatcher.tick();

    // Event still pending because delivery failed; next_retry_at pushed.
    const due = await storage.getWebhookEventsDue(new Date(Date.now() + 60_000), 10);
    const found = due.find((e) => e.id === event.id);
    expect(found).toBeDefined();
    expect(found!.attempts).toBe(1);
    expect(found!.last_status_code).toBe(503);
  });

  it('retry curve has exactly MAX_ATTEMPTS entries and grows monotonically', () => {
    expect(RETRY_CURVE_MS).toHaveLength(MAX_ATTEMPTS);
    for (let i = 1; i < RETRY_CURVE_MS.length; i++) {
      expect(RETRY_CURVE_MS[i]).toBeGreaterThan(RETRY_CURVE_MS[i - 1]!);
    }
  });

  it('nextRetryDate caps at the last curve entry once exhausted', () => {
    const overflowDate = nextRetryDate(MAX_ATTEMPTS + 5);
    const lastDate = nextRetryDate(MAX_ATTEMPTS);
    // Both should be near the same delay (last curve entry) — within 1s tolerance.
    expect(Math.abs(overflowDate.getTime() - lastDate.getTime())).toBeLessThan(1_000);
  });
});
