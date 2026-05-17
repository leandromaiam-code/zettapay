import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetMerchantStoreForTests,
  findMerchantByEmail,
  recordRecoverAttempt,
  rememberMerchant,
} from '../../../api/_lib/merchant-store.js';
import onboardHandler from '../../../api/merchants/onboard.js';
import registerHandler from '../../../api/merchants/register.js';
import recoverHandler from '../../../api/merchants/recover-creds.js';

type Headers = Record<string, string | string[]>;

interface MockRequest {
  method: string;
  body: unknown;
  headers: Headers;
  query: Record<string, unknown>;
}
interface MockResponse {
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  setHeader(name: string, value: string): MockResponse;
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
}

function mockReq(method: string, body: unknown, headers: Headers = {}): MockRequest {
  return { method, body, headers, query: {} };
}
function mockRes(): MockResponse {
  const res: MockResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
  };
  return res;
}

async function invoke(
  handler: (req: unknown, res: unknown) => void,
  req: MockRequest,
  res: MockResponse,
): Promise<void> {
  handler(req as unknown, res as unknown);
  // Give microtasks (none expected, but defensive) a chance.
  await Promise.resolve();
}

describe('Z39B :: merchant email uniqueness', () => {
  beforeEach(() => {
    __resetMerchantStoreForTests();
  });

  it('store dedups by lowercased email', () => {
    expect(findMerchantByEmail('foo@bar.com')).toBeNull();
    rememberMerchant({ id: 'm_1', email: 'Foo@Bar.com', name: 'Foo', createdAt: 'now' });
    const found = findMerchantByEmail('foo@BAR.com');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('m_1');
    expect(found?.email).toBe('foo@bar.com');
  });

  it('recordRecoverAttempt enforces 3/hour', () => {
    const email = 'rate@limit.test';
    expect(recordRecoverAttempt(email).allowed).toBe(true);
    expect(recordRecoverAttempt(email).allowed).toBe(true);
    expect(recordRecoverAttempt(email).allowed).toBe(true);
    const fourth = recordRecoverAttempt(email);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('POST /api/merchants/onboard returns 201 on first signup, 409 on duplicate', async () => {
    const payload = { name: 'Acme Coffee', email: 'owner@acme.test' };

    const res1 = mockRes();
    await invoke(
      onboardHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', payload),
      res1,
    );
    expect(res1.statusCode).toBe(201);
    const body1 = res1.body as { merchant: { id: string }; api_key: string };
    expect(body1.merchant.id).toMatch(/^m_/);
    expect(body1.api_key).toMatch(/^zp_live_/);

    const res2 = mockRes();
    await invoke(
      onboardHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', payload),
      res2,
    );
    expect(res2.statusCode).toBe(409);
    const body2 = res2.body as {
      error: { code: string };
      login_url: string;
      recover_url: string;
    };
    expect(body2.error.code).toBe('email_already_registered');
    expect(body2.login_url).toBe('/signup#login');
    expect(body2.recover_url).toBe('/api/merchants/recover-creds');
  });

  it('POST /api/merchants/onboard is case-insensitive on email', async () => {
    const res1 = mockRes();
    await invoke(
      onboardHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', { name: 'X', email: 'Mixed@Case.io' }),
      res1,
    );
    expect(res1.statusCode).toBe(201);

    const res2 = mockRes();
    await invoke(
      onboardHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', { name: 'X', email: 'mixed@case.io' }),
      res2,
    );
    expect(res2.statusCode).toBe(409);
  });

  it('POST /api/merchants/register dedups by email', async () => {
    const validWallet = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const payload = { name: 'Acme', walletAddress: validWallet, email: 'dup@acme.test' };

    const res1 = mockRes();
    await invoke(
      registerHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', payload),
      res1,
    );
    expect(res1.statusCode).toBe(201);

    const res2 = mockRes();
    await invoke(
      registerHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', payload),
      res2,
    );
    expect(res2.statusCode).toBe(409);
    expect((res2.body as { error: { code: string } }).error.code).toBe('email_already_registered');
  });

  it('POST /api/merchants/onboard rejects invalid email format', async () => {
    const res = mockRes();
    await invoke(
      onboardHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', { name: 'X', email: 'not-an-email' }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe('invalid_email');
  });

  it('POST /api/merchants/recover-creds returns neutral 200 for unknown email', async () => {
    const res = mockRes();
    await invoke(
      recoverHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', { email: 'never-signed-up@ghost.test' }),
      res,
    );
    expect(res.statusCode).toBe(200);
    const body = res.body as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toMatch(/if this email is registered/i);
  });

  it('POST /api/merchants/recover-creds rate-limits after 3 attempts', async () => {
    const payload = { email: 'rate@target.test' };
    for (let i = 0; i < 3; i++) {
      const res = mockRes();
      await invoke(
        recoverHandler as (req: unknown, res: unknown) => void,
        mockReq('POST', payload),
        res,
      );
      expect(res.statusCode).toBe(200);
    }
    const res4 = mockRes();
    await invoke(
      recoverHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', payload),
      res4,
    );
    expect(res4.statusCode).toBe(429);
    expect(res4.headers['Retry-After']).toBeDefined();
  });

  it('POST /api/merchants/recover-creds rejects invalid email', async () => {
    const res = mockRes();
    await invoke(
      recoverHandler as (req: unknown, res: unknown) => void,
      mockReq('POST', { email: 'garbage' }),
      res,
    );
    expect(res.statusCode).toBe(400);
  });
});
