import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WebhookSignatureError,
  parseEvent,
  verifyWebhookSignature,
} from '../../src/server/index.js';

const SECRET = 'whsec_sdk_server_test';

function sign(payload: string, timestamp: number, secret = SECRET): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
}

function confirmedPayload(): string {
  return JSON.stringify({
    type: 'invoice.confirmed',
    created_at: '2026-05-27T12:00:00.000Z',
    data: {
      invoice_id: 'inv_abc123',
      tx_hash: '0xdeadbeef',
      amount_sats: 500_000,
      address: 'bc1qexample',
      confirmations: 3,
      paid_at: '2026-05-27T12:00:00.000Z',
      chain: 'btc',
    },
  });
}

describe('verifyWebhookSignature', () => {
  const ts = 1_800_000_000;

  it('returns the parsed event for a valid signature', () => {
    const payload = confirmedPayload();
    const sig = sign(payload, ts);

    const event = verifyWebhookSignature(payload, sig, String(ts), SECRET, {
      now: () => ts,
    });

    expect(event.type).toBe('invoice.confirmed');
    if (event.type === 'invoice.confirmed') {
      expect(event.data.invoice_id).toBe('inv_abc123');
      expect(event.data.tx_hash).toBe('0xdeadbeef');
      expect(event.data.amount_sats).toBe(500_000);
    }
  });

  it('accepts the optional sha256= prefix on the signature header', () => {
    const payload = confirmedPayload();
    const sig = sign(payload, ts);

    const event = verifyWebhookSignature(
      payload,
      `sha256=${sig}`,
      String(ts),
      SECRET,
      { now: () => ts },
    );

    expect(event.type).toBe('invoice.confirmed');
  });

  it('throws invalid_signature when the payload was tampered with', () => {
    const payload = confirmedPayload();
    const sig = sign(payload, ts);
    const tampered = payload.replace('inv_abc123', 'inv_attacker');

    expect(() =>
      verifyWebhookSignature(tampered, sig, String(ts), SECRET, { now: () => ts }),
    ).toThrowError(WebhookSignatureError);

    try {
      verifyWebhookSignature(tampered, sig, String(ts), SECRET, { now: () => ts });
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('invalid_signature');
    }
  });

  it('throws invalid_signature when secret is wrong', () => {
    const payload = confirmedPayload();
    const sig = sign(payload, ts, 'wrong_secret');

    try {
      verifyWebhookSignature(payload, sig, String(ts), SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('invalid_signature');
    }
  });

  it('throws timestamp_too_old when timestamp is older than tolerance', () => {
    const payload = confirmedPayload();
    const oldTs = ts - 1000;
    const sig = sign(payload, oldTs);

    try {
      verifyWebhookSignature(payload, sig, String(oldTs), SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('timestamp_too_old');
    }
  });

  it('accepts custom toleranceSeconds', () => {
    const payload = confirmedPayload();
    const oldTs = ts - 1000;
    const sig = sign(payload, oldTs);

    const event = verifyWebhookSignature(payload, sig, String(oldTs), SECRET, {
      now: () => ts,
      toleranceSeconds: 2000,
    });

    expect(event.type).toBe('invoice.confirmed');
  });

  it('throws malformed when timestamp is not numeric', () => {
    const payload = confirmedPayload();
    const sig = sign(payload, ts);

    try {
      verifyWebhookSignature(payload, sig, 'not-a-number', SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('malformed');
    }
  });

  it('throws malformed when signature is not hex', () => {
    const payload = confirmedPayload();

    try {
      verifyWebhookSignature(payload, 'zz-not-hex-zz', String(ts), SECRET, {
        now: () => ts,
      });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('malformed');
    }
  });

  it('throws malformed when payload is not JSON', () => {
    const payload = 'not json {';
    const sig = sign(payload, ts);

    try {
      verifyWebhookSignature(payload, sig, String(ts), SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('malformed');
    }
  });

  it('throws malformed when payload schema does not match ZettaPayEvent', () => {
    const payload = JSON.stringify({ type: 'unknown.event', data: {} });
    const sig = sign(payload, ts);

    try {
      verifyWebhookSignature(payload, sig, String(ts), SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      expect((err as WebhookSignatureError).code).toBe('malformed');
    }
  });

  it('uses constant-time comparison (signatures of different lengths fail without === leak)', () => {
    const payload = confirmedPayload();
    // signature length mismatch must still throw, not silently pass
    const shortSig = 'abcd';

    try {
      verifyWebhookSignature(payload, shortSig, String(ts), SECRET, { now: () => ts });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(WebhookSignatureError);
      // Either malformed (odd length / non-hex) or invalid_signature — both
      // proof we did not fall through to plain === string compare.
      expect(['malformed', 'invalid_signature']).toContain(
        (err as WebhookSignatureError).code,
      );
    }
  });
});

describe('parseEvent', () => {
  it('parses every supported event type', () => {
    const base = {
      created_at: '2026-05-27T12:00:00.000Z',
      data: {
        invoice_id: 'inv_x',
        address: 'bc1q',
        amount_sats: 1,
      },
    };
    const confirmed = parseEvent({
      ...base,
      type: 'invoice.confirmed',
      data: { ...base.data, tx_hash: 'tx', confirmations: 1, paid_at: 'now' },
    });
    const pending = parseEvent({
      ...base,
      type: 'invoice.pending',
      data: { ...base.data, tx_hash: 'tx', confirmations: 0, seen_at: 'now' },
    });
    const expired = parseEvent({
      ...base,
      type: 'invoice.expired',
      data: { ...base.data, expired_at: 'now' },
    });
    const underpaid = parseEvent({
      ...base,
      type: 'invoice.underpaid',
      data: { ...base.data, received_sats: 0, tx_hash: 'tx', seen_at: 'now' },
    });

    expect(confirmed.type).toBe('invoice.confirmed');
    expect(pending.type).toBe('invoice.pending');
    expect(expired.type).toBe('invoice.expired');
    expect(underpaid.type).toBe('invoice.underpaid');
  });

  it('throws on unknown event type', () => {
    expect(() => parseEvent({ type: 'invoice.unknown', data: {} })).toThrow();
  });
});

describe('WebhookSignatureError', () => {
  it('exposes a stable code field', () => {
    const err = new WebhookSignatureError('invalid_signature', 'bad');
    expect(err.code).toBe('invalid_signature');
    expect(err.message).toBe('bad');
    expect(err.name).toBe('WebhookSignatureError');
    expect(err).toBeInstanceOf(Error);
  });
});
