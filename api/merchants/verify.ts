import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAnon, isVerificationConfigured } from '../_lib/supabase.js';
import { issueCredentials } from '../_lib/issue-creds.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const OTP_RE = /^\d{6}$/;

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

function handleGet(res: VercelResponse): void {
  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/merchants/verify',
    method: 'POST',
    description:
      'Submit the 6-digit OTP sent via /api/merchants/register. On success, this endpoint flips the merchant status to "active" and emits the credentials — they are shown once.',
    requestBody: {
      email: 'string (required, must match the email used in /register)',
      otp: 'string (required, 6 digits)',
    },
    responses: {
      '200': 'verification ok — credentials returned (shown once)',
      '400': 'invalid input',
      '401': 'invalid or expired code',
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

  const otp = readString(body.otp ?? body.code ?? body.token);
  if (!OTP_RE.test(otp)) {
    jsonError(res, 400, 'invalid_otp_format', 'Field "otp" must be a 6-digit code');
    return;
  }

  const { data, error } = await sb.client.auth.verifyOtp({
    email,
    token: otp,
    type: 'email',
  });

  if (error || !data.user) {
    jsonError(
      res,
      401,
      'invalid_or_expired_code',
      'Invalid or expired verification code. Request a new code and try again.',
    );
    return;
  }

  const shopName =
    (data.user.user_metadata && typeof data.user.user_metadata.shop_name === 'string'
      ? (data.user.user_metadata.shop_name as string)
      : null) ?? null;

  const creds = issueCredentials(email);
  const verifiedAt = new Date().toISOString();

  res.status(200).json({
    ok: true,
    merchant: {
      id: creds.merchantId,
      email,
      shop_name: shopName,
      status: 'active',
      supabase_user_id: data.user.id,
      email_verified_at: verifiedAt,
    },
    listener_key: creds.apiKey,
    webhook_secret: creds.webhookSecret,
    notice:
      'These credentials are shown once. Store them now — we only keep hashes server-side. Re-issue requires a fresh /register + /verify round.',
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
