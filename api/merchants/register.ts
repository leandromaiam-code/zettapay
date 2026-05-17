import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getSupabaseAnon,
  getSupabaseService,
  isVerificationConfigured,
} from '../_lib/supabase.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ErrorBody = { error: { code: string; message: string } };

function jsonError(
  res: VercelResponse,
  status: number,
  code: string,
  message: string,
): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function lookupExistingUser(email: string): Promise<
  | { ok: true; status: 'none' | 'pending' | 'active' }
  | { ok: false; message: string }
> {
  const svc = getSupabaseService();
  if (!svc.ok) {
    return { ok: true, status: 'none' };
  }
  try {
    const lower = email.toLowerCase();
    const { data, error } = await svc.client.auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) return { ok: false, message: error.message };
    const match = (data.users ?? []).find((u) => (u.email ?? '').toLowerCase() === lower);
    if (!match) return { ok: true, status: 'none' };
    if (match.email_confirmed_at) return { ok: true, status: 'active' };
    return { ok: true, status: 'pending' };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'lookup_failed' };
  }
}

function handleGet(res: VercelResponse): void {
  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/merchants/register',
    method: 'POST',
    description:
      'Start merchant signup: sends a 6-digit OTP to the email via Supabase Auth. ' +
      'Credentials are NOT issued here — POST /api/merchants/verify with the code to receive them.',
    requestBody: {
      email: 'string (required, valid email)',
      shop_name: 'string (required, 2-120 chars)',
    },
    responses: {
      '200': 'OTP sent (or resent for a pending merchant)',
      '400': 'invalid input',
      '409': 'email already active — use /verify or rotate via the dashboard',
      '503': 'verification_disabled — SUPABASE_URL / SUPABASE_ANON_KEY missing',
    },
    configured: isVerificationConfigured(),
  });
}

async function handlePost(req: VercelRequest, res: VercelResponse): Promise<void> {
  const sb = getSupabaseAnon();
  if (!sb.ok) {
    jsonError(
      res,
      503,
      'verification_disabled',
      'Email verification is not configured (SUPABASE_URL / SUPABASE_ANON_KEY missing).',
    );
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const email = readString(body.email).toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    jsonError(res, 400, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const shopName = readString(body.shop_name) || readString(body.shopName) || readString(body.name);
  if (shopName.length < 2 || shopName.length > 120) {
    jsonError(res, 400, 'invalid_shop_name', 'Field "shop_name" must be between 2 and 120 characters');
    return;
  }

  const existing = await lookupExistingUser(email);
  if (existing.ok && existing.status === 'active') {
    jsonError(
      res,
      409,
      'merchant_already_active',
      'A verified merchant already exists for this email. Rotate credentials from the dashboard.',
    );
    return;
  }

  const { error } = await sb.client.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: true,
      data: { shop_name: shopName },
    },
  });

  if (error) {
    const status = /rate.?limit/i.test(error.message) ? 429 : 400;
    jsonError(res, status, 'otp_send_failed', error.message);
    return;
  }

  res.status(200).json({
    ok: true,
    email,
    shop_name: shopName,
    status: 'pending_verification',
    message: 'Verification code sent. Check your inbox (and spam) — the code expires in 30 minutes.',
    next: '/api/merchants/verify',
  });
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'POST') {
    await handlePost(req, res);
    return;
  }
  if (req.method === 'GET' || req.method === 'HEAD') {
    handleGet(res);
    return;
  }
  res.setHeader('Allow', 'GET, HEAD, POST');
  jsonError(res, 405, 'method_not_allowed', 'POST or GET only');
}
