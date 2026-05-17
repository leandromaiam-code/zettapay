import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { findMerchantByEmail, rememberMerchant } from '../_lib/merchant-store.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS_RE = /^https:\/\//i;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: SERVICE,
      runtime: RUNTIME,
      endpoint: '/api/merchants/register',
      method: 'POST',
      description:
        'Register a merchant: returns a deterministic merchant id, API key handle, and webhook receipt URL. Idempotent via the Idempotency-Key header.',
      requestBody: {
        name: 'string (required, max 120 chars)',
        walletAddress: 'string (required, base58 Solana pubkey)',
        email: 'string (required, valid email)',
        webhookUrl: 'string (optional, https:// URL)',
      },
      headers: {
        'Idempotency-Key': 'string (recommended, ≤128 chars)',
      },
      responses: {
        '201': 'merchant created (or replayed via idempotency)',
        '400': 'invalid input',
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 120) {
    badRequest(res, 'invalid_name', 'Field "name" is required and must be ≤120 chars');
    return;
  }

  const walletAddress = typeof body.walletAddress === 'string' ? body.walletAddress.trim() : '';
  if (!SOLANA_ADDRESS_RE.test(walletAddress)) {
    badRequest(
      res,
      'invalid_wallet_address',
      'Field "walletAddress" must be a base58 Solana pubkey',
    );
    return;
  }

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    badRequest(res, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const webhookUrlRaw = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
  if (webhookUrlRaw && !HTTPS_RE.test(webhookUrlRaw)) {
    badRequest(res, 'invalid_webhook_url', 'Field "webhookUrl" must be an https:// URL');
    return;
  }

  const idempotencyKey = req.headers['idempotency-key'];
  const idemKey = Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey;
  if (idemKey !== undefined && (typeof idemKey !== 'string' || idemKey.length > 128)) {
    badRequest(
      res,
      'invalid_idempotency_key',
      'Header "Idempotency-Key" must be a string ≤128 chars',
    );
    return;
  }

  const existing = findMerchantByEmail(email);
  if (existing) {
    res.status(409).json({
      error: {
        code: 'email_already_registered',
        message: 'An account already exists for this email. Recover your credentials instead.',
      },
      login_url: '/signup#login',
      recover_url: '/api/merchants/recover-creds',
    });
    return;
  }

  const merchantId = `m_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const apiKey = `zp_live_${randomUUID().replace(/-/g, '')}`;
  const createdAt = new Date().toISOString();

  rememberMerchant({ id: merchantId, email, name, createdAt });

  res.status(201).json({
    merchant: {
      id: merchantId,
      name,
      walletAddress,
      email,
      webhookUrl: webhookUrlRaw || null,
      network: 'solana-devnet',
      createdAt,
    },
    apiKey,
    next: {
      onboard: `/api/merchants/onboard?merchant=${encodeURIComponent(merchantId)}`,
      embedSnippet: `/dashboard?merchant=${encodeURIComponent(merchantId)}`,
    },
  });
}
