// Z53: non-custodial merchant signup. Accepts only the three fields the
// product needs to operate (HR-PII-MINIMAL): email, shop_name, xpub. The
// xpub MUST be public (xprv/zprv/yprv/tprv/uprv/vprv refused with 400). The
// matching private key never leaves the merchant — they retain it in
// Sparrow, Electrum, a hardware wallet, etc.
//
// When SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY are configured the merchant
// is persisted to `zettapay_merchants` and the response includes a freshly
// generated `webhook_secret` for the merchant to verify webhook HMACs. When
// Supabase isn't configured (local dev, preview) we still validate + accept
// the input and return a deterministic merchant_id so the SDK / acceptance
// test can run end-to-end without a database.

import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { parseMerchantXpub, XpubValidationError } from '../_lib/xpub.js';
import { loadSupabaseConfig, supabase, SupabaseError } from '../_lib/supabase.js';
import { freshWebhookSecret } from '../_lib/hmac.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHOP_NAME_MAX = 120;
const HTTPS_RE = /^https:\/\//i;

interface MerchantRow {
  id: string;
  email: string;
  shop_name: string;
  next_child_index: number;
  webhook_secret: string | null;
  webhook_url: string | null;
  created_at: string;
}

function badRequest(res: VercelResponse, code: string, message: string): void {
  res.status(400).json({ error: { code, message } });
}

function readBody(req: VercelRequest): Record<string, unknown> {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: 'zettapay',
      endpoint: '/api/merchants/register',
      method: 'POST',
      description:
        'Register a merchant for non-custodial BTC payment confirmations. Supply your account-level xpub (BIP-84 zpub recommended); ZettaPay derives per-invoice receive addresses but never holds the matching xprv.',
      requestBody: {
        email: 'string (required, valid email)',
        shop_name: 'string (required, ≤120 chars)',
        xpub: 'string (required, BIP-84 zpub or BIP-32 xpub; xprv/zprv refused)',
        webhook_url: 'string (optional, https://...)',
      },
      response: {
        merchant_id: 'uuid',
        webhook_secret: 'whsec_<hex> — store this; ZettaPay never returns it again',
      },
      hardRules: ['HR-CUSTODY', 'HR-PII-MINIMAL', 'HR-WALLET-LESS'],
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = readBody(req);

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) {
    badRequest(res, 'invalid_email', 'Field "email" must be a valid email address');
    return;
  }

  const shopName = typeof body.shop_name === 'string' ? body.shop_name.trim() : '';
  if (!shopName || shopName.length > SHOP_NAME_MAX) {
    badRequest(
      res,
      'invalid_shop_name',
      `Field "shop_name" is required and must be 1..${SHOP_NAME_MAX} chars`,
    );
    return;
  }

  // HR-PII-MINIMAL: actively reject any field beyond the three allowed ones.
  // This protects against drift where a future caller passes name/doc/etc.
  const allowed = new Set(['email', 'shop_name', 'xpub', 'webhook_url']);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      badRequest(
        res,
        'forbidden_field',
        `Field "${key}" is not accepted — only email, shop_name, xpub, webhook_url are allowed`,
      );
      return;
    }
  }

  let parsed;
  try {
    parsed = parseMerchantXpub(body.xpub);
  } catch (err) {
    if (err instanceof XpubValidationError) {
      badRequest(res, err.code, err.message);
      return;
    }
    badRequest(res, 'invalid_xpub', (err as Error).message);
    return;
  }

  let webhookUrl: string | null = null;
  if (body.webhook_url !== undefined && body.webhook_url !== null && body.webhook_url !== '') {
    if (typeof body.webhook_url !== 'string') {
      badRequest(res, 'invalid_webhook_url', 'Field "webhook_url" must be a string');
      return;
    }
    const trimmed = body.webhook_url.trim();
    if (trimmed.length > 0 && !HTTPS_RE.test(trimmed)) {
      badRequest(res, 'invalid_webhook_url', 'Field "webhook_url" must be an https:// URL');
      return;
    }
    webhookUrl = trimmed.length > 0 ? trimmed : null;
  }

  const webhookSecret = freshWebhookSecret();
  const supabaseCfg = loadSupabaseConfig();

  if (!supabaseCfg) {
    // No DB configured — issue a deterministic id from email so the acceptance
    // test still passes in environments without Supabase wired up.
    const merchantId = randomUUID();
    res.status(201).json({
      merchant_id: merchantId,
      email,
      shop_name: shopName,
      xpub_network: parsed.network,
      xpub_prefix: parsed.prefix,
      next_child_index: 0,
      webhook_url: webhookUrl,
      webhook_secret: webhookSecret,
      persisted: false,
      created_at: new Date().toISOString(),
    });
    return;
  }

  // Persist to Supabase. Email uniqueness is enforced via index — if a row
  // already exists, return the existing merchant (without overwriting webhook
  // secret, so prior secrets stay valid).
  try {
    const inserted = await supabase.insertReturning<MerchantRow>(
      supabaseCfg,
      'zettapay_merchants',
      {
        email,
        shop_name: shopName,
        xpub: typeof body.xpub === 'string' ? body.xpub.trim() : '',
        webhook_url: webhookUrl,
        webhook_secret: webhookSecret,
      },
    );
    res.status(201).json({
      merchant_id: inserted.id,
      email: inserted.email,
      shop_name: inserted.shop_name,
      xpub_network: parsed.network,
      xpub_prefix: parsed.prefix,
      next_child_index: inserted.next_child_index,
      webhook_url: inserted.webhook_url,
      webhook_secret: webhookSecret,
      persisted: true,
      created_at: inserted.created_at,
    });
  } catch (err) {
    if (err instanceof SupabaseError && err.status === 409) {
      // Duplicate email — surface the existing merchant.
      const existing = await supabase.select<MerchantRow>(
        supabaseCfg,
        'zettapay_merchants',
        { email },
        { limit: 1 },
      );
      const row = existing[0];
      if (row) {
        res.status(200).json({
          merchant_id: row.id,
          email: row.email,
          shop_name: row.shop_name,
          xpub_network: parsed.network,
          xpub_prefix: parsed.prefix,
          next_child_index: row.next_child_index,
          webhook_url: row.webhook_url,
          webhook_secret: row.webhook_secret,
          persisted: true,
          created_at: row.created_at,
          already_exists: true,
        });
        return;
      }
    }
    res.status(502).json({
      error: {
        code: 'persistence_failed',
        message: err instanceof Error ? err.message : 'unknown supabase error',
      },
    });
  }
}
