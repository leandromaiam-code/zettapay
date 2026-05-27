import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from '../src/hmac.js';

const SECRET = 'whsec_unit_test_secret';

function sigOf(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('hex');
}

describe('computeSignature', () => {
  it('matches node:crypto hmac-sha256 hex output', () => {
    const body = '{"event":"invoice.confirmed"}';
    expect(computeSignature(SECRET, body)).toBe(sigOf(body));
  });

  it('accepts Buffer bodies (raw bytes, not JSON string)', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    expect(computeSignature(SECRET, buf)).toBe(
      createHmac('sha256', SECRET).update(buf).digest('hex'),
    );
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"event":"invoice.confirmed"}');
  const ts = Math.floor(Date.now() / 1000);
  const now = Date.now();

  it('accepts a fresh, well-signed envelope', () => {
    const result = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')),
      timestampHeader: String(ts),
      secret: SECRET,
      now: () => now,
    });
    expect(result.ok).toBe(true);
  });

  it('accepts ms-precision timestamps too', () => {
    const result = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')),
      timestampHeader: String(now),
      secret: SECRET,
      now: () => now,
    });
    expect(result.ok).toBe(true);
  });

  it('rejects when X-ZettaPay-Signature missing', () => {
    const r = verifySignature({
      body,
      signatureHeader: undefined,
      timestampHeader: String(ts),
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'missing_signature' });
  });

  it('rejects when X-ZettaPay-Timestamp missing', () => {
    const r = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')),
      timestampHeader: undefined,
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'missing_timestamp' });
  });

  it('rejects malformed timestamp header', () => {
    const r = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')),
      timestampHeader: 'not-a-number',
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'bad_timestamp' });
  });

  it('rejects timestamps older than maxAgeSeconds (default 300)', () => {
    const oldTs = ts - 600; // 10 min ago
    const r = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')),
      timestampHeader: String(oldTs),
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'timestamp_too_old' });
  });

  it('rejects when signature does not match body', () => {
    const r = verifySignature({
      body,
      signatureHeader: sigOf('different body'),
      timestampHeader: String(ts),
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects when secret differs even if hex length matches', () => {
    const otherSig = createHmac('sha256', 'wrong_secret')
      .update(body)
      .digest('hex');
    const r = verifySignature({
      body,
      signatureHeader: otherSig,
      timestampHeader: String(ts),
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_signature' });
  });

  it('rejects when signature length is wrong (truncated)', () => {
    const r = verifySignature({
      body,
      signatureHeader: sigOf(body.toString('utf8')).slice(0, 32),
      timestampHeader: String(ts),
      secret: SECRET,
      now: () => now,
    });
    expect(r).toMatchObject({ ok: false, reason: 'invalid_signature' });
  });
});
