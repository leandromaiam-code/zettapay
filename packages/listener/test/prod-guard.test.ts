// Prod-guard tests (Z76 FIX 4): in production a missing ZETTAPAY_API_KEY must
// HALT the boot (POST /invoice would be open); in dev it only warns.

import { describe, expect, it } from 'vitest';
import { assertApiKeyForEnv } from '../src/main.js';

describe('assertApiKeyForEnv', () => {
  it('throws when NODE_ENV=production and the API key is missing', () => {
    expect(() => assertApiKeyForEnv({ NODE_ENV: 'production' })).toThrow(/ZETTAPAY_API_KEY/);
  });

  it('passes (no warning) when production AND key present', () => {
    expect(assertApiKeyForEnv({ NODE_ENV: 'production', ZETTAPAY_API_KEY: 'x' })).toBeNull();
  });

  it('only warns (does not throw) in dev when the key is missing', () => {
    const warn = assertApiKeyForEnv({ NODE_ENV: 'development' });
    expect(warn).toMatch(/DEV MODE/);
  });

  it('treats unset NODE_ENV as non-production (dev warning)', () => {
    expect(assertApiKeyForEnv({})).toMatch(/DEV MODE/);
  });

  it('is case-insensitive on NODE_ENV', () => {
    expect(() => assertApiKeyForEnv({ NODE_ENV: 'Production' })).toThrow();
  });
});
