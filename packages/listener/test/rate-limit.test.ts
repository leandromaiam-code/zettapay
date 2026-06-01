// SlidingWindowRateLimiter + parseRateLimitEnv tests (Z76 FIX 3). Pure,
// in-memory; no network, no timers (clock is injected).

import { describe, expect, it } from 'vitest';
import {
  SlidingWindowRateLimiter,
  parseRateLimitEnv,
  DEFAULT_RATE_LIMIT,
} from '../src/rate-limit.js';

describe('SlidingWindowRateLimiter', () => {
  it('allows up to the per-IP ceiling then returns 429-worthy denials', () => {
    let t = 1_000_000;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerWindow: 3, globalPerWindow: 100, windowMs: 60_000 },
      () => t,
    );
    expect(rl.hit('1.1.1.1').allowed).toBe(true);
    expect(rl.hit('1.1.1.1').allowed).toBe(true);
    expect(rl.hit('1.1.1.1').allowed).toBe(true);
    const denied = rl.hit('1.1.1.1');
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('ip');
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks IPs independently', () => {
    let t = 0;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerWindow: 1, globalPerWindow: 100, windowMs: 60_000 },
      () => t,
    );
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true); // different IP unaffected
  });

  it('enforces the global ceiling across IPs', () => {
    let t = 0;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerWindow: 100, globalPerWindow: 2, windowMs: 60_000 },
      () => t,
    );
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('b').allowed).toBe(true);
    const denied = rl.hit('c');
    expect(denied.allowed).toBe(false);
    expect(denied.scope).toBe('global');
  });

  it('slides: old hits age out of the window', () => {
    let t = 0;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerWindow: 2, globalPerWindow: 100, windowMs: 1_000 },
      () => t,
    );
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    t += 1_001; // window elapsed
    expect(rl.hit('a').allowed).toBe(true);
  });

  it('does not count a denied hit toward the window', () => {
    let t = 0;
    const rl = new SlidingWindowRateLimiter(
      { perIpPerWindow: 1, globalPerWindow: 100, windowMs: 60_000 },
      () => t,
    );
    rl.hit('a'); // count 1
    rl.hit('a'); // denied, not counted
    rl.hit('a'); // denied, not counted
    expect(rl.countFor('a')).toBe(1);
  });
});

describe('parseRateLimitEnv', () => {
  it('defaults when unset', () => {
    expect(parseRateLimitEnv(undefined)).toEqual(DEFAULT_RATE_LIMIT);
  });

  it('parses a single per-IP value', () => {
    const cfg = parseRateLimitEnv('10');
    expect(cfg?.perIpPerWindow).toBe(10);
    expect(cfg?.globalPerWindow).toBe(DEFAULT_RATE_LIMIT.globalPerWindow);
  });

  it('parses perIp,global and perIp/global', () => {
    expect(parseRateLimitEnv('10,200')).toMatchObject({ perIpPerWindow: 10, globalPerWindow: 200 });
    expect(parseRateLimitEnv('10/200')).toMatchObject({ perIpPerWindow: 10, globalPerWindow: 200 });
  });

  it('keeps global >= perIp', () => {
    const cfg = parseRateLimitEnv('500,10');
    expect(cfg?.globalPerWindow).toBe(500);
  });

  it('disables limiting on off/0', () => {
    expect(parseRateLimitEnv('off')).toBeNull();
    expect(parseRateLimitEnv('0')).toBeNull();
  });

  it('falls back on garbage instead of crashing', () => {
    expect(parseRateLimitEnv('abc')).toMatchObject({
      perIpPerWindow: DEFAULT_RATE_LIMIT.perIpPerWindow,
    });
  });
});
