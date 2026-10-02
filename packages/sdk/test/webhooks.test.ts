// The verifier is tested against the REAL dispatcher: the listener's
// WebhookDispatcher (packages/listener/src/webhook-dispatcher.ts) is imported
// from source and run with a capturing fetch, so the headers and body checked
// here are byte-for-byte what a merchant endpoint receives. The dispatcher
// does not export its signing helper (the HMAC is computed inline), so driving
// the class itself is the closest possible fixture.
//
// ZettaPay Cloud's CloudWebhookDispatcher (packages/cloud/src/webhook-fleet.ts)
// is not imported — it resolves `@zettapay/listener` from a build that this
// package's CI job does not produce. Its wire format is the same expression
// (`createHmac('sha256', secret).update(body).digest('hex')`, `Date.now()` in
// the timestamp header); the "cloud" case below replicates those lines.

import { createHmac } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileStorage } from '../../listener/src/storage/json.js';
import { WebhookDispatcher } from '../../listener/src/webhook-dispatcher.js';
import {
  computeWebhookSignature,
  verifyWebhook,
  WebhookVerificationError,
  type WebhookVerificationErrorCode,
} from '../src/webhooks/index.js';
import { verifyWebhookSignature } from '../src/server/index.js';

const SECRET = 'whsec_xxxxxxxxxxxxxxxxxxxxxxxx';

const tmpdirs: string[] = [];
afterEach(async () => {
  await Promise.all(tmpdirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

interface Delivery {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Queue `payload` in real listener storage and let the real dispatcher deliver it. */
async function deliverThroughListener(payload: object, eventId = 'evt_sdk_001'): Promise<Delivery> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-sdk-wh-'));
  tmpdirs.push(dir);
  const storage = new JsonFileStorage({ dataDir: dir });
  const merchant = await storage.createMerchant({
    shop_name: 'SDK Test',
    email: 'sdk@example.test',
    xpub: 'zpubExampleSdk',
    webhook_url: 'https://example.test/wh',
    webhook_secret_hash: 'sha256:sdk',
  });
  const invoice = await storage.createInvoice({
    id: 'inv_sdk_001',
    merchant_id: merchant.id,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.00002',
    address: 'bc1qsdktest',
    child_index: 0,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  await storage.recordWebhookEvent({
    id: eventId,
    invoice_id: invoice.id,
    payload_json: JSON.stringify(payload),
    next_retry_at: new Date(Date.now() - 1000).toISOString(),
  });

  let captured: Delivery | null = null;
  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    captured = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: String(init?.body),
    };
    return new Response('', { status: 200 });
  }) as unknown as typeof fetch;

  const dispatcher = new WebhookDispatcher({
    storage,
    webhookUrl: 'https://example.test/wh',
    webhookSecret: SECRET,
    fetchImpl: fakeFetch,
  });
  await dispatcher.tick();
  if (!captured) throw new Error('dispatcher did not deliver');
  return captured;
}

// Payload shapes copied from the emitters:
//   listener.ts emitConfirmedWebhook (BTC)
const BTC_CONFIRMED = {
  event: 'invoice.confirmed',
  invoice_id: 'inv_sdk_001',
  merchant_id: 'default',
  chain: 'btc',
  asset: 'BTC',
  amount: '0.00002',
  address: 'bc1qsdktest',
  tx_hash: 'a'.repeat(64),
  confirmations: 1,
  confirmed_at: '2026-10-02T12:00:00.000Z',
};
//   fixed-address-watcher.ts emitConfirmedWebhook (USDT on Base)
const BASE_FIXED_CONFIRMED = {
  event: 'invoice.confirmed',
  invoice_id: 'inv_sdk_002',
  merchant_id: 'default',
  chain: 'base',
  asset: 'USDT',
  token_address: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2',
  amount: '29000042',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  tx_hash: '0x' + 'b'.repeat(64),
  value: '29000042',
  metadata: { mode: 'fixed-address', ref: 'inv_sdk_002', nonce: 42, asset: 'USDT' },
  confirmed_at: '2026-10-02T12:00:00.000Z',
};
//   fixed-address-watcher.ts emitOrphanWebhook
const ORPHAN = {
  event: 'payment.orphan',
  merchant_id: 'default',
  chain: 'base',
  asset: 'USDC',
  token_address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  tx_hash: '0x' + 'c'.repeat(64),
  value: '29000000',
  detected_at: '2026-10-02T12:00:00.000Z',
};

function expectCode(fn: () => unknown, code: WebhookVerificationErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(WebhookVerificationError);
    expect((err as WebhookVerificationError).code).toBe(code);
    return;
  }
  throw new Error(`expected WebhookVerificationError(${code})`);
}

describe('verifyWebhook against the real listener dispatcher', () => {
  it('accepts a BTC invoice.confirmed delivery exactly as dispatched', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);

    const before = Date.now();
    const out = verifyWebhook({ rawBody: d.body, headers: d.headers, secret: SECRET });

    expect(out.eventId).toBe('evt_sdk_001');
    expect(out.attempt).toBe(1);
    // Milliseconds, not seconds.
    expect(Math.abs(out.timestampMs - before)).toBeLessThan(60_000);
    expect(out.event).toEqual(BTC_CONFIRMED);
    if (out.event.event !== 'invoice.confirmed') throw new Error('wrong narrowing');
    expect(out.event.invoice_id).toBe('inv_sdk_001');
    expect(out.event.confirmations).toBe(1);
  });

  it('accepts the raw body as bytes and headers as a fetch Headers object', async () => {
    const d = await deliverThroughListener(BASE_FIXED_CONFIRMED);
    const out = verifyWebhook({
      rawBody: new TextEncoder().encode(d.body),
      headers: new Headers(d.headers),
      secret: SECRET,
    });
    if (out.event.event !== 'invoice.confirmed') throw new Error('wrong narrowing');
    expect(out.event.asset).toBe('USDT');
    expect(out.event.metadata?.nonce).toBe(42);
  });

  it('accepts lower-cased header names (Node IncomingHttpHeaders)', async () => {
    const d = await deliverThroughListener(ORPHAN);
    const lower = Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const out = verifyWebhook({ rawBody: d.body, headers: lower, secret: SECRET });
    expect(out.event.event).toBe('payment.orphan');
  });

  it('the dispatcher signs the raw body only — the signature helper reproduces it', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);
    expect(d.headers['X-ZettaPay-Signature']).toBe(computeWebhookSignature(d.body, SECRET));
    expect(d.headers['X-ZettaPay-Timestamp']).toMatch(/^\d{13}$/);
  });

  it('rejects a wrong secret, a tampered body and a re-serialised body', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);
    expectCode(
      () => verifyWebhook({ rawBody: d.body, headers: d.headers, secret: 'whsec_yyyyyyyyyyyy' }),
      'signature_mismatch',
    );
    expectCode(
      () =>
        verifyWebhook({
          rawBody: d.body.replace('0.00002', '0.00001'),
          headers: d.headers,
          secret: SECRET,
        }),
      'signature_mismatch',
    );
    expectCode(
      () =>
        verifyWebhook({
          rawBody: JSON.stringify(JSON.parse(d.body), null, 2),
          headers: d.headers,
          secret: SECRET,
        }),
      'signature_mismatch',
    );
  });

  it('rejects missing or malformed headers', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);
    const without = (name: string): Record<string, string> => {
      const h = { ...d.headers };
      delete h[name];
      return h;
    };
    expectCode(
      () => verifyWebhook({ rawBody: d.body, headers: without('X-ZettaPay-Signature'), secret: SECRET }),
      'missing_signature',
    );
    expectCode(
      () =>
        verifyWebhook({
          rawBody: d.body,
          headers: { ...d.headers, 'X-ZettaPay-Signature': 'not-hex' },
          secret: SECRET,
        }),
      'malformed_signature',
    );
    expectCode(
      () => verifyWebhook({ rawBody: d.body, headers: without('X-ZettaPay-Timestamp'), secret: SECRET }),
      'missing_timestamp',
    );
    expectCode(
      () =>
        verifyWebhook({
          rawBody: d.body,
          headers: { ...d.headers, 'X-ZettaPay-Timestamp': 'yesterday' },
          secret: SECRET,
        }),
      'invalid_timestamp',
    );
  });

  it('enforces the timestamp tolerance in milliseconds, and can skip it', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);
    const sent = Number(d.headers['X-ZettaPay-Timestamp']);
    const args = { rawBody: d.body, headers: d.headers, secret: SECRET };

    expect(verifyWebhook({ ...args, now: () => sent + 4 * 60_000 }).timestampMs).toBe(sent);
    expectCode(() => verifyWebhook({ ...args, now: () => sent + 6 * 60_000 }), 'timestamp_out_of_tolerance');
    expectCode(
      () => verifyWebhook({ ...args, toleranceMs: 1000, now: () => sent + 2000 }),
      'timestamp_out_of_tolerance',
    );
    expect(
      verifyWebhook({ ...args, toleranceMs: null, now: () => sent + 86_400_000 }).eventId,
    ).toBe('evt_sdk_001');
  });

  it('rejects a correctly signed body that is not an event object', () => {
    const now = Date.now();
    for (const body of ['not json', '[]', '{"invoice_id":"x"}']) {
      expectCode(
        () =>
          verifyWebhook({
            rawBody: body,
            headers: {
              'X-ZettaPay-Signature': computeWebhookSignature(body, SECRET),
              'X-ZettaPay-Timestamp': String(now),
            },
            secret: SECRET,
          }),
        'invalid_payload',
      );
    }
  });

  it('the pre-pivot verifier rejects the same real delivery (why it is deprecated)', async () => {
    const d = await deliverThroughListener(BTC_CONFIRMED);
    expect(() =>
      verifyWebhookSignature(
        d.body,
        d.headers['X-ZettaPay-Signature'] as string,
        d.headers['X-ZettaPay-Timestamp'] as string,
        SECRET,
      ),
    ).toThrow();
  });
});

describe('verifyWebhook against the Cloud dispatcher wire format', () => {
  it('accepts a delivery signed the way CloudWebhookDispatcher.deliverOne signs', () => {
    // Replicated from packages/cloud/src/webhook-fleet.ts deliverOne().
    const body = JSON.stringify(BASE_FIXED_CONFIRMED);
    const signature = createHmac('sha256', SECRET).update(body).digest('hex');
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'X-ZettaPay-Signature': signature,
      'X-ZettaPay-Timestamp': String(Date.now()),
      'X-ZettaPay-Event-Id': 'evt_cloud_001',
      'X-ZettaPay-Attempt': String(3),
    };

    const out = verifyWebhook({ rawBody: body, headers, secret: SECRET });
    expect(out.eventId).toBe('evt_cloud_001');
    expect(out.attempt).toBe(3);
    expect(out.event).toEqual(BASE_FIXED_CONFIRMED);
  });
});
