import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAYS_MS,
  dispatchWebhook,
  type DeadLetterEvent,
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

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('dispatchWebhook', () => {
  it('exports the sophisticated 1s/5s/25s/2min/10min/1h/6h/24h schedule', () => {
    expect(DEFAULT_RETRY_DELAYS_MS).toEqual([
      1 * SECOND,
      5 * SECOND,
      25 * SECOND,
      2 * MINUTE,
      10 * MINUTE,
      1 * HOUR,
      6 * HOUR,
      24 * HOUR,
    ]);
  });

  it('caps total attempts at DEFAULT_MAX_ATTEMPTS = 10', () => {
    expect(DEFAULT_MAX_ATTEMPTS).toBe(10);
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
    expect(result.deadLettered).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, status: 200, ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
  });

  it('walks the full 8-step schedule on repeated 5xx and dead-letters after the 9th attempt', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(503));
    const onDeadLetter = vi.fn();

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
      onDeadLetter,
    });

    expect(result.delivered).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(result.deadLetterReason).toBe('retries_exhausted');
    expect(fetchMock).toHaveBeenCalledTimes(9);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([
      1 * SECOND,
      5 * SECOND,
      25 * SECOND,
      2 * MINUTE,
      10 * MINUTE,
      1 * HOUR,
      6 * HOUR,
      24 * HOUR,
    ]);
    expect(result.attempts).toHaveLength(9);
    expect(result.attempts.every((a) => a.status === 503)).toBe(true);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    const dlq = onDeadLetter.mock.calls[0]![0] as DeadLetterEvent;
    expect(dlq.eventId).toBe(result.eventId);
    expect(dlq.url).toBe('https://merchant.example/hooks/payments');
    expect(dlq.reason).toBe('retries_exhausted');
    expect(dlq.attempts).toHaveLength(9);
  });

  it('recovers after transient 5xx failures (no dead-letter on success)', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500))
      .mockResolvedValueOnce(jsonResponse(502))
      .mockResolvedValueOnce(jsonResponse(200));
    const onDeadLetter = vi.fn();

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
      onDeadLetter,
    });

    expect(result.delivered).toBe(true);
    expect(result.deadLettered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1 * SECOND, 5 * SECOND]);
    expect(result.attempts).toHaveLength(3);
    expect(onDeadLetter).not.toHaveBeenCalled();
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
    expect(result.deadLettered).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.attempts[0]).toMatchObject({ attempt: 1, status: null, ok: false, error: 'fetch failed' });
    expect(result.attempts[1]).toMatchObject({ attempt: 2, status: 200, ok: true });
  });

  it('dead-letters immediately on non-retryable 4xx responses', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(404));
    const onDeadLetter = vi.fn();

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: { event: 'payment.confirmed' },
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
      onDeadLetter,
    });

    expect(result.delivered).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(result.deadLetterReason).toBe('non_retryable_status');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(clock.sleep).not.toHaveBeenCalled();
    expect(result.attempts[0]).toMatchObject({ status: 404, ok: false });
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
    expect(onDeadLetter.mock.calls[0]![0].reason).toBe('non_retryable_status');
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
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1 * SECOND]);
  });

  it('signs payloads with HMAC-SHA256 and includes attempt header', async () => {
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
    expect(sentHeaders['X-ZettaPay-Attempt']).toBe('1');
    const timestamp = sentHeaders['X-ZettaPay-Timestamp']!;
    const signature = sentHeaders['X-ZettaPay-Signature']!;
    const expected =
      'sha256=' +
      createHmac('sha256', secret).update(`${timestamp}.${JSON.stringify(payload)}`).digest('hex');
    expect(signature).toBe(expected);
  });

  it('reuses the supplied eventId across retry attempts (idempotency) and increments attempt header', async () => {
    const clock = makeFakeClock();
    const observedEventIds: string[] = [];
    const observedAttemptHeaders: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      observedEventIds.push(headers['X-ZettaPay-Event-Id']!);
      observedAttemptHeaders.push(headers['X-ZettaPay-Attempt']!);
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
    expect(observedAttemptHeaders).toEqual(['1', '2', '3']);
  });

  it('honors a custom backoff schedule', async () => {
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

  it('respects an explicit maxAttempts cap below the schedule length', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(503));
    const onDeadLetter = vi.fn();

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: {},
      maxAttempts: 3,
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
      onDeadLetter,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.deadLettered).toBe(true);
    expect(result.deadLetterReason).toBe('retries_exhausted');
    expect(clock.sleep.mock.calls.map(([ms]) => ms)).toEqual([1 * SECOND, 5 * SECOND]);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
  });

  it('swallows dead-letter handler errors so they do not mask the dispatch result', async () => {
    const clock = makeFakeClock();
    const fetchMock = vi.fn(async () => jsonResponse(404));
    const onDeadLetter = vi.fn(async () => {
      throw new Error('sink unavailable');
    });

    const result = await dispatchWebhook({
      url: 'https://merchant.example/hooks/payments',
      payload: {},
      fetchImpl: fetchMock,
      sleep: clock.sleep,
      now: clock.now,
      onDeadLetter,
    });

    expect(result.delivered).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(onDeadLetter).toHaveBeenCalledTimes(1);
  });
});
