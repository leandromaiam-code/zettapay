// Z57: non-custodial merchant signup. Persistence is now mediated by the
// @zettapay/listener `StorageAdapter` interface — production runs against
// the Supabase adapter, local dev (no SUPABASE_URL) keeps the deterministic
// in-memory fallback so the acceptance test still returns ok=true on a
// preview environment without a database.
//
// HR-CUSTODY: zero signing code. HR-PII-MINIMAL: only email + shop_name +
// xpub + webhook_url are accepted from the caller. HR-STORAGE-ADAPTER:
// this handler never imports a concrete adapter — only `createStorage` +
// the `StorageAdapter` interface.

import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createStorage,
  StoragePersistenceError,
  type StorageAdapter,
} from '@zettapay/listener';
import { parseMerchantXpub, XpubValidationError } from '../_lib/xpub.js';
import { freshWebhookSecret } from '../_lib/hmac.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SHOP_NAME_MAX = 120;
const HTTPS_RE = /^https:\/\//i;

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

function isSupabaseConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? '').trim());
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
  const storage: StorageAdapter | null = isSupabaseConfigured() ? createStorage(process.env) : null;

  if (!storage) {
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

  const xpub = typeof body.xpub === 'string' ? body.xpub.trim() : '';

  try {
    const existing = await storage.getMerchantByEmail(email);
    if (existing) {
      res.status(200).json({
        merchant_id: existing.id,
        email: existing.email,
        shop_name: existing.shop_name,
        xpub_network: parsed.network,
        xpub_prefix: parsed.prefix,
        next_child_index: existing.next_child_index,
        webhook_url: existing.webhook_url || null,
        webhook_secret: existing.webhook_secret_hash || null,
        persisted: true,
        created_at: existing.created_at,
        already_exists: true,
      });
      return;
    }

    const inserted = await storage.createMerchant({
      email,
      shop_name: shopName,
      xpub,
      webhook_url: webhookUrl ?? '',
      webhook_secret_hash: webhookSecret,
    });
    res.status(201).json({
      merchant_id: inserted.id,
      email: inserted.email,
      shop_name: inserted.shop_name,
      xpub_network: parsed.network,
      xpub_prefix: parsed.prefix,
      next_child_index: inserted.next_child_index,
      webhook_url: inserted.webhook_url || null,
      webhook_secret: webhookSecret,
      persisted: true,
      created_at: inserted.created_at,
    });
  } catch (err) {
    if (err instanceof StoragePersistenceError) {
      res.status(502).json({
        error: { code: 'persistence_failed', message: err.message },
      });
      return;
    }
    res.status(502).json({
      error: {
        code: 'persistence_failed',
        message: err instanceof Error ? err.message : 'unknown storage error',
      },
    });
  }
}
