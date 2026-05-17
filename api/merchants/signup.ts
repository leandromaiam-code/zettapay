// POST /api/merchants/signup — non-custodial xpub registration.
//
// HR-CUSTODY: we accept ONLY {email, shop_name, xpub, webhook_url}. xprv/zprv
// are rejected at the boundary so signing material can never enter the DB.
// HR-PII-MINIMAL: no name, KYC, doc, address — xpub is technical metadata.
// HR-SECRETS-IN-GIT: webhook_secret is generated server-side and returned
// once; persistence stores its sha256 fingerprint so a DB dump can't replay.

import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { rejectPrivateMaterial, isXpub } from '../_lib/xpub.js';
import { insertRow, isPostgrestError, supabaseConfigured } from '../_lib/supabase-rest.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HTTPS_RE = /^https:\/\//i;
const SHOP_RE = /^[a-zA-Z0-9 .,'_\-&]{1,80}$/;

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

interface MerchantInsert extends Record<string, unknown> {
  id: string;
  email: string;
  shop_name: string;
  xpub: string;
  xpub_derivation_index: number;
  webhook_url: string | null;
  webhook_secret_sha256: string;
  created_at: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: 'zettapay',
      endpoint: '/api/merchants/signup',
      method: 'POST',
      description:
        'Register a merchant by providing a BIP84 zpub or BIP32 xpub. ZettaPay derives a fresh bech32 P2WPKH address per invoice and never holds signing keys.',
      requestBody: {
        email: 'string (required, valid email, ≤254 chars)',
        shop_name: 'string (required, ≤80 chars)',
        xpub: 'string (required, BIP84 zpub or BIP32 xpub — xprv/zprv rejected)',
        webhook_url: 'string (optional, https:// URL — receives paid notifications)',
      },
      responses: {
        '201': 'merchant created',
        '400': 'invalid input (private keys, malformed xpub, missing fields)',
        '503': 'supabase unconfigured (env var missing)',
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    fail(res, 405, 'method_not_allowed', 'POST or GET only');
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    fail(res, 400, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const shopName = typeof body.shop_name === 'string' ? body.shop_name.trim() : '';
  if (!SHOP_RE.test(shopName)) {
    fail(res, 400, 'invalid_shop_name', 'Field "shop_name" must be 1-80 printable chars');
    return;
  }

  const xpubRaw = typeof body.xpub === 'string' ? body.xpub.trim() : '';
  if (xpubRaw.length === 0) {
    fail(res, 400, 'invalid_xpub', 'Field "xpub" is required');
    return;
  }
  try {
    rejectPrivateMaterial(xpubRaw);
  } catch {
    fail(res, 400, 'private_keys_forbidden', 'private keys forbidden');
    return;
  }
  if (!isXpub(xpubRaw)) {
    fail(res, 400, 'invalid_xpub', 'Field "xpub" must be a BIP84 zpub or BIP32 xpub');
    return;
  }

  const webhookUrlRaw = typeof body.webhook_url === 'string' ? body.webhook_url.trim() : '';
  if (webhookUrlRaw && !HTTPS_RE.test(webhookUrlRaw)) {
    fail(res, 400, 'invalid_webhook_url', 'Field "webhook_url" must be an https:// URL');
    return;
  }

  const merchantId = `m_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const webhookSecret = `whsec_${randomBytes(24).toString('hex')}`;
  const webhookSecretFingerprint = createHash('sha256').update(webhookSecret).digest('hex');
  const createdAt = new Date().toISOString();

  if (!supabaseConfigured()) {
    // Dev path: return a deterministic-shaped response so SDK consumers can
    // exercise the surface without Supabase wired. Production gates on env.
    res.status(201).json({
      merchant: {
        id: merchantId,
        email,
        shop_name: shopName,
        xpub: xpubRaw,
        xpub_derivation_index: 0,
        webhook_url: webhookUrlRaw || null,
        created_at: createdAt,
      },
      webhook_secret: webhookSecret,
      persisted: false,
      note: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — response returned but row not persisted.',
    });
    return;
  }

  const row: MerchantInsert = {
    id: merchantId,
    email,
    shop_name: shopName,
    xpub: xpubRaw,
    xpub_derivation_index: 0,
    webhook_url: webhookUrlRaw || null,
    webhook_secret_sha256: webhookSecretFingerprint,
    created_at: createdAt,
  };

  const inserted = await insertRow<MerchantInsert>('merchants', row);
  if (isPostgrestError(inserted)) {
    if (inserted.status === 409 || inserted.message.includes('duplicate')) {
      fail(res, 409, 'merchant_exists', 'A merchant with this email already exists');
      return;
    }
    fail(res, 502, 'persist_failed', `Failed to persist merchant: ${inserted.message}`);
    return;
  }

  res.status(201).json({
    merchant: {
      id: inserted.id,
      email: inserted.email,
      shop_name: inserted.shop_name,
      xpub: inserted.xpub,
      xpub_derivation_index: inserted.xpub_derivation_index,
      webhook_url: inserted.webhook_url,
      created_at: inserted.created_at,
    },
    webhook_secret: webhookSecret,
    persisted: true,
  });
}
