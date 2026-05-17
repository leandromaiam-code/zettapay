// Admin API key gate (Z45). Used by every /api/admin/* function. Compares
// in constant time, refuses requests when ZETTAPAY_ADMIN_API_KEY is missing
// (rather than defaulting to allow), and accepts the header in either
// `Authorization: Bearer <key>` or `X-Admin-Api-Key: <key>` form.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

export interface AdminAuthFailure {
  code: 'unauthorized' | 'config_error';
  message: string;
}

export interface AdminAuthSuccess {
  ok: true;
}

export type AdminAuthResult = AdminAuthSuccess | (AdminAuthFailure & { ok: false });

export function checkAdminAuth(req: VercelRequest): AdminAuthResult {
  const expected = process.env.ZETTAPAY_ADMIN_API_KEY?.trim() ?? '';
  if (expected.length < 24) {
    return {
      ok: false,
      code: 'config_error',
      message: 'admin endpoint disabled: set ZETTAPAY_ADMIN_API_KEY (>=24 chars)',
    };
  }

  const supplied = extractKey(req);
  if (!supplied) {
    return { ok: false, code: 'unauthorized', message: 'missing admin api key' };
  }

  if (!safeEqual(supplied, expected)) {
    return { ok: false, code: 'unauthorized', message: 'invalid admin api key' };
  }

  return { ok: true };
}

export function rejectAdmin(res: VercelResponse, failure: AdminAuthFailure): void {
  const status = failure.code === 'unauthorized' ? 401 : 503;
  res.status(status).json({ error: { code: failure.code, message: failure.message } });
}

function extractKey(req: VercelRequest): string | null {
  const headerKey = firstHeader(req, 'x-admin-api-key');
  if (headerKey) return headerKey.trim();
  const auth = firstHeader(req, 'authorization');
  if (auth && /^bearer\s+/i.test(auth)) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }
  return null;
}

function firstHeader(req: VercelRequest, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? null;
  return raw ?? null;
}

function safeEqual(a: string, b: string): boolean {
  // Bring both sides to a constant length via HMAC fingerprints so the
  // attacker can't learn key length from the comparison cost.
  const key = 'zettapay-admin-fingerprint';
  const ah = createHmac('sha256', key).update(a).digest();
  const bh = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(ah, bh);
}
