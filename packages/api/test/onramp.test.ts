import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createHmac } from 'node:crypto';
import { buildApp, type AppHandle } from '../src/app.js';
import { openDb } from '../src/db.js';
import {
  MOONPAY_SIGNATURE_HEADER,
  OnrampSignatureError,
  PAYMENT_CONFIRMED_EVENT,
  processOnrampWebhook,
  verifyMoonpaySignature,
  type MoonpayWebhookPayload,
} from '../src/onramp.js';
import { PaymentLog } from '../src/payments.js';
import type { WebhookDispatchResult } from '../src/webhook.js';

const SECRET = 'whsec_test_secret';

function signBody(body: string, secret = SECRET, timestamp = Date.now()): string {
  const ts = String(timestamp);
  const digest = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},s=${digest}`;
}

function completedPayload(overrides: Partial<MoonpayWebhookPayload['data']> = {}): MoonpayWebhookPayload {
  return {
    type: 'transaction_updated',
    data: {
      id: 'tx_123',
      externalTransactionId: 'ext_abc',
      status: 'completed',
      baseCurrencyAmount: 100,
      quoteCurrencyAmount: 99.5,
      walletAddress: 'SoLa1NaWaLLet1',
      baseCurrency: { code: 'usd' },
      quoteCurrency: { code: 'usdc_sol' },
      createdAt: '2026-05-09T12:00:00Z',
      updatedAt: '2026-05-09T12:01:00Z',
      ...overrides,
    },
  };
}

describe('verifyMoonpaySignature', () => {
  it('accepts a payload with a valid HMAC signature within tolerance', () => {
    const body = JSON.stringify({ hello: 'world' });
    const header = signBody(body);
    expect(() =>
      verifyMoonpaySignature({
        signatureHeader: header,
        rawBody: body,
        secret: SECRET,
      }),
    ).not.toThrow();
  });

  it('rejects a missing header with code missing_signature', () => {
    expect(() =>
      verifyMoonpaySignature({
        signatureHeader: undefined,
        rawBody: '{}',
        secret: SECRET,
      }),
    ).toThrowError(OnrampSignatureError);
  });

  it('rejects a tampered body (different signature)', () => {
    const body = JSON.stringify({ hello: 'world' });
    const header = signBody(body);
    expect(() =>
      verifyMoonpaySignature({
        signatureHeader: header,
        rawBody: JSON.stringify({ hello: 'tampered' }),
        secret: SECRET,
      }),
    ).toThrowError(/signature digest does not match/);
  });

  it('rejects a stale timestamp outside tolerance', () => {
    const body = '{}';
    const stale = Date.now() - 10 * 60 * 1000;
    const header = signBody(body, SECRET, stale);
    let captured: unknown;
    try {
      verifyMoonpaySignature({
        signatureHeader: header,
        rawBody: body,
        secret: SECRET,
        toleranceMs: 60_000,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(OnrampSignatureError);
    expect((captured as OnrampSignatureError).code).toBe('expired_signature');
  });

  it('rejects a malformed header', () => {
    let captured: unknown;
    try {
      verifyMoonpaySignature({
        signatureHeader: 'garbage-without-equals',
        rawBody: '{}',
        secret: SECRET,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(OnrampSignatureError);
    expect((captured as OnrampSignatureError).code).toBe('invalid_signature_format');
  });
});

describe('processOnrampWebhook', () => {
  it('records a completed onramp transaction and returns created=true', async () => {
    const payments = new PaymentLog();
    const outcome = await processOnrampWebhook({
      payload: completedPayload(),
      payments,
    });
    expect(outcome.kind).toBe('recorded');
    if (outcome.kind !== 'recorded') return;
    expect(outcome.created).toBe(true);
    expect(outcome.record.source).toBe('onramp');
    if (outcome.record.source === 'onramp') {
      expect(outcome.record.externalTransactionId).toBe('ext_abc');
      expect(outcome.record.baseAmount).toBe(100);
      expect(outcome.record.quoteCurrency).toBe('usdc_sol');
    }
    expect(payments.count()).toBe(1);
  });

  it('is idempotent on the externalTransactionId — second delivery returns the original record', async () => {
    const payments = new PaymentLog();
    const first = await processOnrampWebhook({ payload: completedPayload(), payments });
    const second = await processOnrampWebhook({ payload: completedPayload(), payments });
    expect(first.kind).toBe('recorded');
    expect(second.kind).toBe('recorded');
    if (first.kind !== 'recorded' || second.kind !== 'recorded') return;
    expect(second.created).toBe(false);
    expect(second.record.id).toBe(first.record.id);
    expect(payments.count()).toBe(1);
  });

  it('ignores events with status other than completed', async () => {
    const payments = new PaymentLog();
    const outcome = await processOnrampWebhook({
      payload: completedPayload({ status: 'pending' }),
      payments,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'incomplete_status' });
    expect(payments.count()).toBe(0);
  });

  it('ignores unsupported event types', async () => {
    const payments = new PaymentLog();
    const outcome = await processOnrampWebhook({
      payload: { ...completedPayload(), type: 'transaction_failed' } as MoonpayWebhookPayload,
      payments,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'unsupported_event' });
  });

  it('dispatches a payment.confirmed event to the configured merchant URL on first record', async () => {
    const payments = new PaymentLog();
    const dispatch = vi.fn(
      async (): Promise<WebhookDispatchResult> => ({
        delivered: true,
        deadLettered: false,
        eventId: 'evt',
        attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 10 }],
      }),
    );
    const outcome = await processOnrampWebhook({
      payload: completedPayload(),
      payments,
      notify: { url: 'https://merchant.example/hooks', secret: 'm-secret' },
      dispatch,
    });
    expect(outcome.kind).toBe('recorded');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]![0];
    expect(call.url).toBe('https://merchant.example/hooks');
    expect(call.secret).toBe('m-secret');
    const payload = call.payload as Record<string, unknown>;
    expect(payload.event).toBe(PAYMENT_CONFIRMED_EVENT);
    expect(payload.source).toBe('onramp');
    expect(payload.externalTransactionId).toBe('ext_abc');
  });

  it('does not dispatch outbound webhook on a duplicate delivery', async () => {
    const payments = new PaymentLog();
    const dispatch = vi.fn(
      async (): Promise<WebhookDispatchResult> => ({
        delivered: true,
        deadLettered: false,
        eventId: 'evt',
        attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 1 }],
      }),
    );
    await processOnrampWebhook({
      payload: completedPayload(),
      payments,
      notify: { url: 'https://merchant.example/hooks' },
      dispatch,
    });
    await processOnrampWebhook({
      payload: completedPayload(),
      payments,
      notify: { url: 'https://merchant.example/hooks' },
      dispatch,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});

describe('POST /onramp/webhook', () => {
  let handle: AppHandle;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dispatch = vi.fn(
      async (): Promise<WebhookDispatchResult> => ({
        delivered: true,
        deadLettered: false,
        eventId: 'evt',
        attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 1 }],
      }),
    );
    handle = buildApp({
      db: openDb({ filename: ':memory:' }),
      onrampWebhookSecret: SECRET,
      onrampNotify: { url: 'https://merchant.example/hooks', secret: 'm' },
      onrampDispatch: dispatch as unknown as typeof import('../src/webhook.js').dispatchWebhook,
    });
  });

  afterEach(() => {
    handle.db.close();
  });

  it('200s and records a completed onramp event when signature is valid', async () => {
    const body = JSON.stringify(completedPayload());
    const sig = signBody(body);

    const res = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, sig)
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.ignored).toBe(false);
    expect(res.body.deduplicated).toBe(false);
    expect(handle.payments.count()).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('401s when the signature header is missing', async () => {
    const body = JSON.stringify(completedPayload());
    const res = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('missing_signature');
    expect(handle.payments.count()).toBe(0);
  });

  it('401s when the signature digest is wrong', async () => {
    const body = JSON.stringify(completedPayload());
    const ts = String(Date.now());
    const bogus = `t=${ts},s=${'a'.repeat(64)}`;
    const res = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, bogus)
      .send(body);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('invalid_signature');
  });

  it('400s on a body that is not valid JSON', async () => {
    const body = 'not-json';
    const sig = signBody(body);
    const res = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, sig)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_json');
  });

  it('400s when the payload does not match the Moonpay shape', async () => {
    const body = JSON.stringify({ type: 'transaction_updated', data: {} });
    const sig = signBody(body);
    const res = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, sig)
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('invalid_payload');
  });

  it('200s and reports deduplicated=true on duplicate delivery', async () => {
    const body = JSON.stringify(completedPayload());
    const sig = signBody(body);

    await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, sig)
      .send(body);

    const second = await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, signBody(body))
      .send(body);

    expect(second.status).toBe(200);
    expect(second.body.deduplicated).toBe(true);
    expect(handle.payments.count()).toBe(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('503s when the webhook secret is not configured', async () => {
    const noSecretHandle = buildApp({
      db: openDb({ filename: ':memory:' }),
      onrampWebhookSecret: undefined,
    });
    try {
      const body = JSON.stringify(completedPayload());
      const res = await request(noSecretHandle.app)
        .post('/onramp/webhook')
        .set('content-type', 'application/json')
        .set(MOONPAY_SIGNATURE_HEADER, signBody(body))
        .send(body);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('onramp_disabled');
    } finally {
      noSecretHandle.db.close();
    }
  });

  it('records onramp into PaymentLog and remains visible in the unified list', async () => {
    const body = JSON.stringify(completedPayload());
    const sig = signBody(body);
    await request(handle.app)
      .post('/onramp/webhook')
      .set('content-type', 'application/json')
      .set(MOONPAY_SIGNATURE_HEADER, sig)
      .send(body);

    const list = handle.payments.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.source).toBe('onramp');

    const onlyOnramp = handle.payments.list({ source: 'onramp' });
    expect(onlyOnramp).toHaveLength(1);
    const onlyX402 = handle.payments.list({ source: 'x402' });
    expect(onlyX402).toHaveLength(0);
  });
});
