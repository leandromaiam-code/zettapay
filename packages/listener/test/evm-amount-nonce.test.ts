// evm-amount-nonce tests — the pure decimal-nonce allocator/encoder/matcher
// behind the fixed-address USDC mode (Z74). No I/O, no network.

import { describe, expect, it } from 'vitest';
import {
  allocateNonce,
  allocateNonceShuffled,
  baseUnitsForUsd,
  encodeAmount,
  isValidEvmAddress,
  matchAmount,
  NONCE_MAX,
  NONCE_MODULUS,
  NONCE_STRIDE,
  randomNonceOffset,
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

describe('NONCE constants', () => {
  it('reserves 4 decimals (modulus 10000, max 9999)', () => {
    expect(NONCE_MODULUS).toBe(10_000);
    expect(NONCE_MAX).toBe(9_999);
  });

  it('uses a stride coprime to NONCE_MAX (full permutation walk)', () => {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    expect(gcd(NONCE_STRIDE, NONCE_MAX)).toBe(1);
  });
});

describe('allocateNonceShuffled (FIX 6 — non-sequential)', () => {
  it('returns a valid in-range nonce', () => {
    const n = allocateNonceShuffled(new Set(), 0);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(NONCE_MAX);
  });

  it('does not allocate sequentially from a non-zero offset', () => {
    // With offset 0 the first nonce is start(0)+stride+1; consecutive draws are
    // spaced by NONCE_STRIDE, never the adjacent integer.
    const active = new Set<number>();
    const first = allocateNonceShuffled(active, 0);
    active.add(first);
    const second = allocateNonceShuffled(active, 0);
    expect(Math.abs(second - first)).not.toBe(1);
  });

  it('produces a unique permutation across the whole pool (no repeats, no gaps)', () => {
    const active = new Set<number>();
    const seen = new Set<number>();
    for (let i = 0; i < NONCE_MAX; i += 1) {
      const n = allocateNonceShuffled(active, 1234);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(NONCE_MAX);
      expect(seen.has(n)).toBe(false);
      seen.add(n);
      active.add(n);
    }
    expect(seen.size).toBe(NONCE_MAX);
  });

  it('throws when the pool is exhausted', () => {
    const full = new Set<number>();
    for (let n = 1; n <= NONCE_MAX; n += 1) full.add(n);
    expect(() => allocateNonceShuffled(full, 7)).toThrow(/exhausted/);
  });

  it('skips already-active nonces', () => {
    const first = allocateNonceShuffled(new Set(), 0);
    const n = allocateNonceShuffled(new Set([first]), 0);
    expect(n).not.toBe(first);
  });
});

describe('randomNonceOffset', () => {
  it('returns an integer within the nonce range', () => {
    for (let i = 0; i < 50; i += 1) {
      const o = randomNonceOffset();
      expect(Number.isInteger(o)).toBe(true);
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(NONCE_MAX);
    }
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
