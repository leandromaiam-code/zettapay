// rate-limit tests (Z76, FIX 3) — pure in-memory sliding window, no network.
// A controllable clock drives window expiry deterministically.

import { describe, expect, it } from 'vitest';
import {
  parseRateLimitEnv,
  SlidingWindowRateLimiter,
  DEFAULT_RATE_LIMIT,
} from '../src/rate-limit.js';

describe('parseRateLimitEnv', () => {
  it('returns defaults when unset or blank', () => {
    expect(parseRateLimitEnv(undefined)).toMatchObject({
      perIpPerMin: DEFAULT_RATE_LIMIT.perIpPerMin,
      globalPerMin: DEFAULT_RATE_LIMIT.globalPerMin,
    });
    expect(parseRateLimitEnv('  ')).toMatchObject({ perIpPerMin: 30, globalPerMin: 300 });
  });

  it('parses "<perIp>" and "<perIp>,<global>"', () => {
    expect(parseRateLimitEnv('10')).toMatchObject({ perIpPerMin: 10, globalPerMin: 300 });
    expect(parseRateLimitEnv('10,50')).toMatchObject({ perIpPerMin: 10, globalPerMin: 50 });
    expect(parseRateLimitEnv('10, 50')).toMatchObject({ perIpPerMin: 10, globalPerMin: 50 });
  });

  it('accepts 0 (disables an axis) and falls back on garbage', () => {
    expect(parseRateLimitEnv('0,0')).toMatchObject({ perIpPerMin: 0, globalPerMin: 0 });
    expect(parseRateLimitEnv('abc')).toMatchObject({ perIpPerMin: 30 });
  });
});

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the per-IP limit then returns 429-scope ip', () => {
    let now = 1_000_000;
    const rl = new SlidingWindowRateLimiter({ perIpPerMin: 3, globalPerMin: 0 }, () => now);
    expect(rl.check('1.1.1.1').ok).toBe(true);
    expect(rl.check('1.1.1.1').ok).toBe(true);
    expect(rl.check('1.1.1.1').ok).toBe(true);
    const blocked = rl.check('1.1.1.1');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('ip');
  });

  it('isolates IPs — one abusive client does not starve another', () => {
    let now = 1_000_000;
    const rl = new SlidingWindowRateLimiter({ perIpPerMin: 1, globalPerMin: 0 }, () => now);
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('a').ok).toBe(false);
    expect(rl.check('b').ok).toBe(true);
  });

  it('enforces the global ceiling across all IPs', () => {
    let now = 1_000_000;
    const rl = new SlidingWindowRateLimiter({ perIpPerMin: 0, globalPerMin: 2 }, () => now);
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('b').ok).toBe(true);
    const blocked = rl.check('c');
    expect(blocked.ok).toBe(false);
    expect(blocked.scope).toBe('global');
  });

  it('frees capacity once the window rolls past', () => {
    let now = 1_000_000;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerMin: 1, globalPerMin: 0, windowMs: 1_000 },
      () => now,
    );
    expect(rl.check('a').ok).toBe(true);
    expect(rl.check('a').ok).toBe(false);
    now += 1_001;
    expect(rl.check('a').ok).toBe(true);
  });

  it('treats limit 0 as disabled on both axes (always allowed)', () => {
    let now = 1_000_000;
    const rl = new SlidingWindowRateLimiter({ perIpPerMin: 0, globalPerMin: 0 }, () => now);
    for (let i = 0; i < 100; i += 1) expect(rl.check('a').ok).toBe(true);
  });
});
