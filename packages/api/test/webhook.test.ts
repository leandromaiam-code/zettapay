import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_RETRY_DELAYS_MS,
  dispatchWebhook,
  type WebhookDispatchResult,
} from '../src/webhook.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
  startedAt: number;
}

function makeFakeClock() {
  let current = 0;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    }),
  };
}

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('dispatchWebhook', () => {
  it('exports the canonical (1s, 5s, 15s) backoff schedule', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([1_000, 5_000, 15_000]);
  });

  it('delivers on first 2xx and does not retry', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(200));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed', amount: '10.00' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, status: 200, ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('retries with the canonical 1s/5s/15s schedule on repeated 5xx and gives up after 4 attempts', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(503));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 5_000, 15_000]);
    expect(result.attempts.map((a) => a.status)).toEqual([503, 503, 503, 503]);
  });

  it('recovers after transient 5xx failures', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(502))
      .mockResolvedValueOnce(jsonResponse(200));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 5_000]);
    expect(result.attempts).toHaveLength(3);
  });

  it('retries on transport errors (network failure)', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, status: null, ok: false, error: 'fetch failed' });
    expect(result.attempts[1]).toMatchObject({ attempt: 2, status: 200, ok: true });
  });

  it('does not retry on non-retryable 4xx responses', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(404));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(result.attempts[0]).toMatchObject({ status: 404, ok: false });
  });

  it('still retries on 408, 425 and 429 (retryable client errors)', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429))
      .mockResolvedValueOnce(jsonResponse(200));

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
  });

  it('signs payloads with HMAC-SHA256 using the configured secret', async () => {
    const clock = makeFakeClock();
    const calls: RecordedCall[] = [];
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init, startedAt: clock.now() });
      return jsonResponse(200);
    });
    const secret = 'test-secret';
    const payload = { event: 'payment.confirmed', amount: '42.00' };

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload,
      secret,
      eventId: 'evt_1',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(calls).toHaveLength(1);
    const sentHeaders = calls[0]!.init.headers as Record<string, string>;
    expect(sentHeaders['X-ZettaPay-Event-Id']).toBe('evt_1');
    const timestamp = sentHeaders['X-ZettaPay-Timestamp']!;
    const signature = sentHeaders['X-ZettaPay-Signature']!;
    const expected =
      'sha256=' +
      createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest('hex');
    expect(signature).toBe(expected);
  });

  it('reuses the supplied eventId across retry attempts (idempotency)', async () => {
    const clock = makeFakeClock();
    const observedEventIds: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedEventIds.push(headers['X-ZettaPay-Event-Id']!);
      return observedEventIds.length < 3 ? jsonResponse(503) : jsonResponse(200);
    });

    const result: WebhookDispatchResult = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      eventId: 'evt_stable',
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(result.delivered).toBe(true);
    expect(result.eventId).toBe('evt_stable');
    expect(observedEventIds).toEqual(['evt_stable', 'evt_stable', 'evt_stable']);
  });

  it('honors a custom backoff schedule (allowing tests to verify exponential 1/5/15 spec)', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(503));

    await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: {},
      retryDelaysMs: [10, 20],
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20]);
  });
});
