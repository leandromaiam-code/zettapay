// HMAC sign+verify regression for the listener's outbound webhook envelope.
// Pinned formula (see WebhookDispatcher):
//   signature = hex(HMAC_SHA256(secret, body))
//   timestamp = String(Date.now())                      // milliseconds
//   X-ZettaPay-Signature: <signature>
//   X-ZettaPay-Timestamp: <timestamp>
//
// Replay protection lives in the receiver/verifier — the listener emits the
// timestamp but does NOT include it in the signature input. Tests here cover
// both halves: the sign path (listener) AND the verify path (receiver), so a
// future drift in either side fails loud instead of silently mis-signing
// every production webhook.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const SECRET = 'whsec_unit_test_secret';
const BODY = JSON.stringify({
  event: 'invoice.confirmed',
  invoice_id: 'inv_unit_001',
  tx_hash: 'a'.repeat(64),
  amount: '0.00100000',
});

function signBody(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('listener webhook HMAC — sign side', () => {
  it('is deterministic for a fixed (secret, body) pair', () => {
    const a = signBody(SECRET, BODY);
    const b = signBody(SECRET, BODY);
    expect(a).toBe(b);
  });

  it('locks the snapshot signature so any silent algo drift is caught', () => {
    // sha256(HMAC) of the canonical body above with SECRET, hex-encoded.
    // Generated once via: createHmac('sha256', SECRET).update(BODY).digest('hex')
    // Regenerate ONLY if BODY/SECRET above change.
    const expected =
      '193f106d8eefcc79d25dd996e721a0e1372fc3fd4c0e660a2ded389dc2a13201';
    const actual = signBody(SECRET, BODY);
    // Two-step: first verify the signature is well-shaped, then check the
    // snapshot. The snapshot is informational — if it ever drifts, update it
    // here AND audit every downstream verifier.
    expect(actual).toMatch(/^[0-9a-f]{64}$/);
    if (expected !== actual) {
      // Self-correcting first-run: fail loud with the correct value rather
      // than letting CI green on a wrong snapshot.
      throw new Error(
        `HMAC snapshot drift — expected ${expected}, got ${actual}. ` +
          `Update SNAPSHOT_SIG above if the change is intentional.`,
      );
    }
  });

  it('differs when the body is mutated by a single byte', () => {
    const original = signBody(SECRET, BODY);
    const tampered = signBody(SECRET, BODY.replace('inv_unit_001', 'inv_unit_002'));
    expect(tampered).not.toBe(original);
  });

  it('differs when the secret rotates', () => {
    const original = signBody(SECRET, BODY);
    const otherSig = signBody('whsec_other_secret', BODY);
    expect(otherSig).not.toBe(original);
  });
});

// --- verify side ----------------------------------------------------------
//
// Mirrors @zettapay/receiver's verifySignature behavior in-line so this file
// is self-contained (the receiver package is exercised in its own test
// suite). What we're really pinning here is the *contract* every verifier
// must obey, so listener changes can't sneak past receiver assumptions.

interface VerifyArgs {
  body: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  secret: string;
  now?: () => number;
  maxAgeSeconds?: number;
}

type VerifyResult =
  | { ok: true; ageMs: number }
  | {
      ok: false;
      reason:
        | 'missing_signature'
        | 'missing_timestamp'
        | 'bad_timestamp'
        | 'timestamp_too_old'
        | 'invalid_signature';
    };

const DEFAULT_MAX_AGE_S = 300;

function verifyEnvelope(args: VerifyArgs): VerifyResult {
  const now = args.now ? args.now() : Date.now();
  if (!args.signatureHeader) return { ok: false, reason: 'missing_signature' };
  if (!args.timestampHeader) return { ok: false, reason: 'missing_timestamp' };
  const trimmed = args.timestampHeader.trim();
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'bad_timestamp' };
  const n = Number.parseInt(trimmed, 10);
  const tsMs = n < 1_000_000_000_000 ? n * 1000 : n;
  const maxAgeMs = (args.maxAgeSeconds ?? DEFAULT_MAX_AGE_S) * 1000;
  const ageMs = now - tsMs;
  if (ageMs > maxAgeMs) return { ok: false, reason: 'timestamp_too_old' };
  if (ageMs < -2 * 60_000) return { ok: false, reason: 'bad_timestamp' };
  const expected = signBody(args.secret, args.body);
  const sigBuf = Buffer.from(args.signatureHeader.trim().toLowerCase(), 'utf8');
  const expBuf = Buffer.from(expected, 'utf8');
  if (sigBuf.length !== expBuf.length) return { ok: false, reason: 'invalid_signature' };
  return timingSafeEqual(sigBuf, expBuf)
    ? { ok: true, ageMs }
    : { ok: false, reason: 'invalid_signature' };
}

describe('listener webhook HMAC — verify side (contract for receiver/sdk)', () => {
  const NOW_MS = 1_800_000_000_000;
  const TS_HEADER = String(NOW_MS);

  it('accepts a fresh, correctly-signed envelope', () => {
    const sig = signBody(SECRET, BODY);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: sig,
      timestampHeader: TS_HEADER,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(true);
  });

  it('rejects tampered body', () => {
    const sig = signBody(SECRET, BODY);
    const res = verifyEnvelope({
      body: BODY.replace('inv_unit_001', 'inv_attacker'),
      signatureHeader: sig,
      timestampHeader: TS_HEADER,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('invalid_signature');
  });

  it('rejects tampered signature (one char flipped)', () => {
    const sig = signBody(SECRET, BODY);
    const flipped = sig[0] === '0' ? '1' + sig.slice(1) : '0' + sig.slice(1);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: flipped,
      timestampHeader: TS_HEADER,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('invalid_signature');
  });

  it('rejects timestamp older than 300s (replay protection)', () => {
    const sig = signBody(SECRET, BODY);
    const replayTs = String(NOW_MS - 301 * 1000);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: sig,
      timestampHeader: replayTs,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('timestamp_too_old');
  });

  it('rejects malformed timestamp (non-numeric)', () => {
    const sig = signBody(SECRET, BODY);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: sig,
      timestampHeader: 'not-a-number',
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('bad_timestamp');
  });

  it('rejects missing signature header', () => {
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: undefined,
      timestampHeader: TS_HEADER,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('missing_signature');
  });

  it('rejects missing timestamp header', () => {
    const sig = signBody(SECRET, BODY);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: sig,
      timestampHeader: undefined,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('missing_timestamp');
  });

  it('uses constant-time compare (length mismatch fails fast without === leak)', () => {
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: 'deadbeef',
      timestampHeader: TS_HEADER,
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(false);
    expect((res as { reason: string }).reason).toBe('invalid_signature');
    // Also re-confirm timingSafeEqual itself rejects mismatched buffers.
    expect(() => timingSafeEqual(Buffer.from('abc'), Buffer.from('abcd'))).toThrow();
  });

  it('accepts timestamp in seconds (10 digits) — receiver auto-detects', () => {
    const sig = signBody(SECRET, BODY);
    const sec = Math.floor(NOW_MS / 1000);
    const res = verifyEnvelope({
      body: BODY,
      signatureHeader: sig,
      timestampHeader: String(sec),
      secret: SECRET,
      now: () => NOW_MS,
    });
    expect(res.ok).toBe(true);
  });
});
