import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_HEADER,
  EVENT_ID_HEADER,
  MemoryEventStore,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  dedupe,
  parseWebhook,
} from '../src/index.js';

const SECRET = 'whsec_test_idempotency';

function signedHeaders(opts: {
  body: string;
  eventId: string;
  timestamp: number;
  attempt?: number;
  secret?: string;
}): Record<string, string> {
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${opts.timestamp}.${opts.body}`)
    .digest('hex');
  const headers: Record<string, string> = {
    [SIGNATURE_HEADER]: `sha256=${sig}`,
    [TIMESTAMP_HEADER]: String(opts.timestamp),
    [EVENT_ID_HEADER]: opts.eventId,
  };
  if (opts.attempt !== undefined) headers[ATTEMPT_HEADER] = String(opts.attempt);
  return headers;
}

describe('parseWebhook', () => {
  const body = JSON.stringify({ type: 'payment.succeeded', data: { id: 'pay_123' } });
  const ts = 1_700_000_000_000;
  const eventId = 'evt_01HABCD';

  it('verifies signature, decodes payload, and returns the event id for dedup', () => {
    const result = parseWebhook({
      secret: SECRET,
      body,
      headers: signedHeaders({ body, eventId, timestamp: ts, attempt: 2 }),
      now: () => ts,
    });

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.event.eventId).toBe(eventId);
    expect(result.event.timestamp).toBe(ts);
    expect(result.event.attempt).toBe(2);
    expect(result.event.rawBody).toBe(body);
    expect(result.event.payload).toEqual({ type: 'payment.succeeded', data: { id: 'pay_123' } });
  });

  it('accepts a Buffer body just like the raw express body', () => {
    const result = parseWebhook({
      secret: SECRET,
      body: Buffer.from(body, 'utf8'),
      headers: signedHeaders({ body, eventId, timestamp: ts }),
      now: () => ts,
    });
    expect(result.valid).toBe(true);
  });

  it('reads headers from a Fetch-API Headers instance (case-insensitive)', () => {
    const headers = new Headers(signedHeaders({ body, eventId, timestamp: ts }));
    const result = parseWebhook({ secret: SECRET, body, headers, now: () => ts });
    expect(result.valid).toBe(true);
  });

  it('rejects a missing event id — without it merchants cannot dedupe', () => {
    const headers = signedHeaders({ body, eventId, timestamp: ts });
    delete headers[EVENT_ID_HEADER];
    const result = parseWebhook({ secret: SECRET, body, headers, now: () => ts });
    expect(result).toEqual({ valid: false, reason: 'missing_event_id' });
  });

  it('rejects a tampered payload via signature mismatch', () => {
    const headers = signedHeaders({ body, eventId, timestamp: ts });
    const result = parseWebhook({
      secret: SECRET,
      body: body + 'tampered',
      headers,
      now: () => ts,
    });
    expect(result).toEqual({ valid: false, reason: 'signature_mismatch' });
  });

  it('rejects a stale timestamp outside the 5min tolerance window', () => {
    const result = parseWebhook({
      secret: SECRET,
      body,
      headers: signedHeaders({ body, eventId, timestamp: ts }),
      now: () => ts + 6 * 60 * 1000,
    });
    expect(result).toEqual({ valid: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('rejects a malformed signature header', () => {
    const headers = signedHeaders({ body, eventId, timestamp: ts });
    headers[SIGNATURE_HEADER] = 'sha256=not-hex!!!';
    const result = parseWebhook({ secret: SECRET, body, headers, now: () => ts });
    expect(result).toEqual({ valid: false, reason: 'malformed_signature' });
  });

  it('rejects payloads that fail JSON parsing', () => {
    const broken = '{not-json';
    const result = parseWebhook({
      secret: SECRET,
      body: broken,
      headers: signedHeaders({ body: broken, eventId, timestamp: ts }),
      now: () => ts,
    });
    expect(result).toEqual({ valid: false, reason: 'invalid_payload' });
  });

  it('lets parsePayload narrow the payload type and surfaces validation errors', () => {
    interface PaymentEvent {
      type: 'payment.succeeded';
      data: { id: string };
    }
    const ok = parseWebhook<PaymentEvent>({
      secret: SECRET,
      body,
      headers: signedHeaders({ body, eventId, timestamp: ts }),
      now: () => ts,
      parsePayload: (raw) => {
        const obj = raw as PaymentEvent;
        if (obj.type !== 'payment.succeeded') throw new Error('unexpected');
        return obj;
      },
    });
    expect(ok.valid).toBe(true);
    if (ok.valid) expect(ok.event.payload.data.id).toBe('pay_123');

    const bad = parseWebhook<PaymentEvent>({
      secret: SECRET,
      body,
      headers: signedHeaders({ body, eventId, timestamp: ts }),
      now: () => ts,
      parsePayload: () => {
        throw new Error('schema mismatch');
      },
    });
    expect(bad).toEqual({ valid: false, reason: 'invalid_payload' });
  });
});

describe('MemoryEventStore + dedupe', () => {
  it('marks the first delivery fresh and every replay duplicate', async () => {
    const store = new MemoryEventStore();
    const first = await dedupe('evt_a', store);
    const second = await dedupe('evt_a', store);
    const third = await dedupe('evt_b', store);

    expect(first).toEqual({ fresh: true, duplicate: false });
    expect(second).toEqual({ fresh: false, duplicate: true });
    expect(third).toEqual({ fresh: true, duplicate: false });
    expect(store.size).toBe(2);
  });

  it('evicts oldest entries once maxEntries is reached', () => {
    const store = new MemoryEventStore({ maxEntries: 2 });
    store.add('evt_1');
    store.add('evt_2');
    store.add('evt_3');
    expect(store.has('evt_1')).toBe(false);
    expect(store.has('evt_2')).toBe(true);
    expect(store.has('evt_3')).toBe(true);
  });

  it('survives the realistic dispatcher retry loop — 3 deliveries of the same eventId', async () => {
    const store = new MemoryEventStore();
    const body = JSON.stringify({ type: 'payment.succeeded' });
    const ts = 1_700_000_000_000;
    const eventId = 'evt_retry_idem';
    const processed: string[] = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const parsed = parseWebhook({
        secret: SECRET,
        body,
        headers: signedHeaders({ body, eventId, timestamp: ts, attempt }),
        now: () => ts,
      });
      expect(parsed.valid).toBe(true);
      if (!parsed.valid) continue;
      const { duplicate } = await dedupe(parsed.event.eventId, store);
      if (!duplicate) processed.push(parsed.event.eventId);
    }

    expect(processed).toEqual([eventId]);
  });
});
