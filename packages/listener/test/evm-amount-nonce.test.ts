// evm-amount-nonce tests — the pure decimal-nonce allocator/encoder/matcher
// behind the fixed-address USDC mode (Z74). No I/O, no network.

import { describe, expect, it } from 'vitest';
import {
  allocateNonce,
  baseUnitsForUsd,
  encodeAmount,
  isValidEvmAddress,
  matchAmount,
  randomNonceStart,
  NONCE_MAX,
  NONCE_MODULUS,
} from '../src/evm-amount-nonce.js';

describe('baseUnitsForUsd', () => {
  it('zeroes the last 4 decimal places', () => {
    expect(baseUnitsForUsd(29)).toBe(29_000000);
    expect(baseUnitsForUsd(1)).toBe(1_000000);
    // 29.0001 USD → 29_000100 base units → nonce digits zeroed → 29_000000
    expect(baseUnitsForUsd(29.0001)).toBe(29_000000);
  });
});

describe('encodeAmount', () => {
  it('embeds the nonce in the low decimals ($29, nonce 42 → 29.000042)', () => {
    const enc = encodeAmount(29, 42);
    expect(enc.units).toBe(29_000042n);
    expect(enc.baseUnits).toBe(29_000000n);
    expect(enc.nonce).toBe(42);
    expect(enc.display).toBe('29.000042');
  });

  it('renders nonce 1 and NONCE_MAX correctly', () => {
    expect(encodeAmount(29, 1).display).toBe('29.000001');
    expect(encodeAmount(29, NONCE_MAX).units).toBe(29_009999n);
  });

  it('rejects out-of-range nonces', () => {
    expect(() => encodeAmount(29, 0)).toThrow();
    expect(() => encodeAmount(29, NONCE_MAX + 1)).toThrow();
    expect(() => encodeAmount(29, 1.5)).toThrow();
  });
});

describe('matchAmount', () => {
  it('recovers the nonce from base + nonce', () => {
    expect(matchAmount(29_000042n, 29_000000n)).toBe(42);
  });

  it('returns 0 for a round amount (ambiguous, no nonce)', () => {
    expect(matchAmount(29_000000n, 29_000000n)).toBe(0);
  });

  it('returns null when received is below base', () => {
    expect(matchAmount(28_999999n, 29_000000n)).toBeNull();
  });

  it('returns null when surplus exceeds the nonce range', () => {
    expect(matchAmount(29_010000n, 29_000000n)).toBeNull();
  });

  it('accepts number inputs', () => {
    expect(matchAmount(29_000007, 29_000000)).toBe(7);
  });
});

describe('allocateNonce', () => {
  it('returns 1 when nothing is active', () => {
    expect(allocateNonce(new Set())).toBe(1);
  });

  it('returns the smallest free nonce', () => {
    expect(allocateNonce(new Set([1, 2, 4]))).toBe(3);
  });

  it('skips a contiguous run', () => {
    expect(allocateNonce(new Set([1, 2, 3]))).toBe(4);
  });

  it('throws when the pool is exhausted', () => {
    const full = new Set<number>();
    for (let n = 1; n <= NONCE_MAX; n += 1) full.add(n);
    expect(() => allocateNonce(full)).toThrow(/exhausted/);
  });
});

describe('allocateNonce shuffle (Z76 FIX 6 — anti front-running)', () => {
  it('starts the search at the given start and wraps the ring', () => {
    // start=5000, nothing active → returns 5000 (non-sequential origin).
    expect(allocateNonce(new Set(), 5000)).toBe(5000);
    // start near the top wraps back to 1 when the tail is occupied.
    const tailFull = new Set<number>();
    for (let n = NONCE_MAX - 2; n <= NONCE_MAX; n += 1) tailFull.add(n);
    expect(allocateNonce(tailFull, NONCE_MAX - 2)).toBe(1);
  });

  it('still guarantees uniqueness from an arbitrary start', () => {
    const active = new Set<number>();
    const picked = new Set<number>();
    let start = 4242;
    for (let i = 0; i < 500; i += 1) {
      const n = allocateNonce(active, start);
      expect(picked.has(n)).toBe(false); // never a collision
      picked.add(n);
      active.add(n);
      start = (start % NONCE_MAX) + 7; // jump the origin around each time
    }
    expect(picked.size).toBe(500);
  });

  it('default start (legacy) is still deterministic smallest-free', () => {
    expect(allocateNonce(new Set([1, 2, 4]))).toBe(3);
  });

  it('randomNonceStart yields values inside 1..NONCE_MAX', () => {
    for (let i = 0; i < 200; i += 1) {
      const s = randomNonceStart();
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThanOrEqual(NONCE_MAX);
    }
  });
});

describe('NONCE constants', () => {
  it('reserves 4 decimals (modulus 10000, max 9999)', () => {
    expect(NONCE_MODULUS).toBe(10_000);
    expect(NONCE_MAX).toBe(9_999);
  });
});

describe('isValidEvmAddress', () => {
  it('accepts all-lowercase and all-uppercase 40-hex addresses', () => {
    expect(isValidEvmAddress('0x' + 'a'.repeat(40))).toBe(true);
    expect(isValidEvmAddress('0x' + 'A'.repeat(40))).toBe(true);
  });

  it('accepts a correctly checksummed mixed-case address', () => {
    expect(isValidEvmAddress('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
  });

  it('rejects a mixed-case address with a bad checksum', () => {
    expect(isValidEvmAddress('0xf39fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isValidEvmAddress('0x123')).toBe(false);
    expect(isValidEvmAddress('not-an-address')).toBe(false);
  });
});
