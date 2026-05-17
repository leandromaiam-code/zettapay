import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSupabaseAnon, isVerificationConfigured } from '../_lib/supabase.js';
import { issueCredentials } from '../_lib/issue-creds.js';

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

function extractBearerToken(req: VercelRequest): string | null {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  return match ? (match[1] ?? null) : null;
}

function handleGet(res: VercelResponse): void {
  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/merchants/issue-creds',
    method: 'POST',
    description:
      'Re-issue merchant credentials. Requires a valid Supabase session Bearer token whose email matches the body — i.e. the merchant must have completed /verify first.',
    requestBody: {
      email: 'string (required, must match Authorization bearer)',
    },
    headers: {
      Authorization: 'Bearer <supabase_access_token> (required)',
    },
    responses: {
      '200': 'credentials returned (shown once)',
      '400': 'invalid input',
      '403': 'verification_required — no valid session bound to this email',
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

  const token = extractBearerToken(req);
  if (!token) {
    jsonError(
      res,
      403,
      'verification_required',
      'Missing Authorization bearer token. Complete /api/merchants/verify first.',
    );
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;
  const email = (typeof body.email === 'string' ? body.email.trim() : '').toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) {
    jsonError(res, 400, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const { data, error } = await sb.client.auth.getUser(token);
  if (error || !data.user) {
    jsonError(
      res,
      403,
      'verification_required',
      'Bearer token is invalid or expired. Complete /api/merchants/verify first.',
    );
    return;
  }
  if (!data.user.email_confirmed_at) {
    jsonError(
      res,
      403,
      'verification_required',
      'Email has not been verified yet. Complete /api/merchants/verify first.',
    );
    return;
  }
  if ((data.user.email ?? '').toLowerCase() !== email) {
    jsonError(
      res,
      403,
      'verification_required',
      'Bearer token does not match the email in the request body.',
    );
    return;
  }

  const creds = issueCredentials(email);
  res.status(200).json({
    ok: true,
    merchant: {
      id: creds.merchantId,
      email,
      supabase_user_id: data.user.id,
      email_verified_at: data.user.email_confirmed_at,
    },
    listener_key: creds.apiKey,
    webhook_secret: creds.webhookSecret,
    notice:
      'These credentials are shown once. Storage is hash-only on our side — losing them forces a /verify + /issue-creds round trip.',
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
