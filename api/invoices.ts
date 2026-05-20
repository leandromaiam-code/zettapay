// Z57: create a non-custodial invoice. Derives a per-invoice receive address
// from the merchant's stored xpub at m/0/{next_child_index}, atomically
// increments the index, and persists the invoice via the StorageAdapter.
//
// Confirmation policy (btc-confirmations.ts): 1 conf <$50, 3 conf <$500,
// 6 conf ≥$500. The listener flips status pending → detected → confirmed
// and fires the webhook when the threshold is crossed.

import { randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createStorage,
  StoragePersistenceError,
  type StorageAdapter,
} from '@zettapay/listener';
import { deriveBip84Receive, parseMerchantXpub, XpubValidationError } from './_lib/xpub.js';
import { usdToBtc, getBtcUsdSpot } from './_lib/btc-pricing.js';
import { requiredConfirmations } from './_lib/btc-confirmations.js';

const SUPPORTED_CHAINS = ['btc'] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

const MIN_AMOUNT_USD = 0.01;
const MAX_AMOUNT_USD = 1_000_000;
const DEFAULT_TTL_SECONDS = 1_800;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_METADATA_BYTES = 4 * 1024;

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

function originFromRequest(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const hostStr = Array.isArray(host) ? host[0] : host;
  return hostStr ? `${proto}://${hostStr}` : 'https://zettapay.io';
}

function buildBip21Uri(address: string, amountBtc: string): string {
  return `bitcoin:${address}?amount=${amountBtc}`;
}

function isSupportedChain(value: unknown): value is Chain {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function isSupabaseConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? '').trim());
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: 'zettapay',
      endpoint: '/api/invoices',
      method: 'POST',
      description:
        'Create a non-custodial BTC invoice. ZettaPay derives a child address from the merchant xpub at m/0/{next_child_index} and watches it for inbound payments.',
      requestBody: {
        merchant_id: 'uuid (required)',
        amount_usd: `number (required, ${MIN_AMOUNT_USD}..${MAX_AMOUNT_USD})`,
        chain: '"btc" (required, only BTC supported in Z53)',
        ttl_seconds: `number (optional, 60..${MAX_TTL_SECONDS}, default ${DEFAULT_TTL_SECONDS})`,
        metadata: 'object (optional, ≤4KB serialized)',
        xpub: 'string (only used when merchant_id is unknown — dev fallback)',
      },
      confirmationPolicy: { '<50_usd': 1, '<500_usd': 3, '>=500_usd': 6 },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = readBody(req);

  const chainRaw = body.chain ?? 'btc';
  if (!isSupportedChain(chainRaw)) {
    badRequest(res, 'invalid_chain', 'Field "chain" must be "btc" — Z53 ships BTC only');
    return;
  }
  const chain: Chain = chainRaw;

  const amountUsdRaw = body.amount_usd;
  const amountUsd = typeof amountUsdRaw === 'number' ? amountUsdRaw : Number(amountUsdRaw);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_AMOUNT_USD || amountUsd > MAX_AMOUNT_USD) {
    badRequest(
      res,
      'invalid_amount',
      `Field "amount_usd" must be a number in [${MIN_AMOUNT_USD}, ${MAX_AMOUNT_USD}]`,
    );
    return;
  }

  let ttl = DEFAULT_TTL_SECONDS;
  if (body.ttl_seconds !== undefined && body.ttl_seconds !== null) {
    const t = Number(body.ttl_seconds);
    if (!Number.isFinite(t) || t < 60 || t > MAX_TTL_SECONDS) {
      badRequest(res, 'invalid_ttl', `Field "ttl_seconds" must be in [60, ${MAX_TTL_SECONDS}]`);
      return;
    }
    ttl = Math.floor(t);
  }

  let metadata: Record<string, unknown> | undefined;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      badRequest(res, 'invalid_metadata', 'Field "metadata" must be a JSON object');
      return;
    }
    const serialized = JSON.stringify(body.metadata);
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      badRequest(res, 'metadata_too_large', `metadata must be ≤${MAX_METADATA_BYTES} bytes`);
      return;
    }
    metadata = body.metadata as Record<string, unknown>;
  }

  const merchantIdRaw = body.merchant_id;
  const merchantId = typeof merchantIdRaw === 'string' ? merchantIdRaw.trim() : '';
  const storage: StorageAdapter | null = isSupabaseConfigured() ? createStorage(process.env) : null;

  let merchantXpub: string | null = null;
  let resolvedMerchantId = merchantId;
  let childIndex: number | null = null;

  if (storage && merchantId) {
    try {
      const merchant = await storage.getMerchant(merchantId);
      if (!merchant) {
        badRequest(res, 'merchant_not_found', `No merchant with id "${merchantId}"`);
        return;
      }
      merchantXpub = merchant.xpub;
      childIndex = await storage.nextChildIndex(merchantId);
    } catch (err) {
      if (err instanceof StoragePersistenceError) {
        res.status(502).json({
          error: { code: 'persistence_failed', message: err.message },
        });
        return;
      }
      throw err;
    }
  }

  if (merchantXpub === null) {
    const xpubField = body.xpub;
    if (typeof xpubField !== 'string' || xpubField.length === 0) {
      badRequest(
        res,
        'missing_merchant_or_xpub',
        'Provide either "merchant_id" (with Supabase configured) or "xpub" for inline derivation',
      );
      return;
    }
    merchantXpub = xpubField;
    if (!resolvedMerchantId) {
      resolvedMerchantId = `m_${randomBytes(12).toString('hex')}`;
    }
    const childIndexRaw = body.child_index;
    if (childIndexRaw !== undefined && childIndexRaw !== null) {
      const idx = Number(childIndexRaw);
      if (!Number.isInteger(idx) || idx < 0 || idx >= 0x80000000) {
        badRequest(res, 'invalid_child_index', 'child_index must be a non-hardened uint32');
        return;
      }
      childIndex = idx;
    } else {
      childIndex = 0;
    }
  }

  let parsed;
  try {
    parsed = parseMerchantXpub(merchantXpub);
  } catch (err) {
    if (err instanceof XpubValidationError) {
      badRequest(res, err.code, err.message);
      return;
    }
    throw err;
  }

  if (childIndex === null) {
    res.status(500).json({
      error: { code: 'child_index_unresolved', message: 'failed to allocate child index' },
    });
    return;
  }
  const derived = deriveBip84Receive(parsed, childIndex);
  const amountBtc = await usdToBtc(amountUsd);
  const required = requiredConfirmations(amountUsd);
  const invoiceId = `inv_${randomBytes(16).toString('hex')}`;
  const nowMs = Date.now();
  const expiresIso = new Date(nowMs + ttl * 1000).toISOString();
  const origin = originFromRequest(req);
  const qrUri = buildBip21Uri(derived.address, amountBtc);

  if (storage && resolvedMerchantId.length === 36) {
    try {
      const inserted = await storage.createInvoice({
        id: invoiceId,
        merchant_id: resolvedMerchantId,
        chain,
        asset: 'BTC',
        amount: amountBtc,
        address: derived.address,
        child_index: childIndex,
        status: 'pending',
        expires_at: expiresIso,
        receive_address: derived.address,
        amount_usd: amountUsd,
        amount_btc: amountBtc,
        required_confirmations: required,
        metadata: metadata ?? null,
      });
      res.status(201).json({
        invoice_id: inserted.id,
        merchant_id: inserted.merchant_id,
        chain: inserted.chain,
        child_index: inserted.child_index,
        derivation_path: derived.path,
        receive_address: inserted.receive_address ?? inserted.address,
        amount_usd: inserted.amount_usd ?? amountUsd,
        amount_btc: inserted.amount_btc ?? amountBtc,
        required_confirmations: inserted.required_confirmations ?? required,
        status: inserted.status,
        qr_uri: qrUri,
        expires_at: inserted.expires_at,
        spot_btc_usd: await getBtcUsdSpot(),
        network: derived.network,
        persisted: true,
        verify_url: `https://mempool.space/address/${inserted.receive_address ?? inserted.address}`,
        self: `${origin}/api/invoices/${inserted.id}`,
        metadata: inserted.metadata ?? null,
      });
      return;
    } catch (err) {
      res.status(502).json({
        error: {
          code: 'invoice_persist_failed',
          message: err instanceof Error ? err.message : 'unknown storage error',
        },
        invoice_id: invoiceId,
        receive_address: derived.address,
      });
      return;
    }
  }

  res.status(201).json({
    invoice_id: invoiceId,
    merchant_id: resolvedMerchantId,
    chain,
    child_index: childIndex,
    derivation_path: derived.path,
    receive_address: derived.address,
    amount_usd: amountUsd,
    amount_btc: amountBtc,
    required_confirmations: required,
    status: 'pending',
    qr_uri: qrUri,
    expires_at: expiresIso,
    spot_btc_usd: await getBtcUsdSpot(),
    network: derived.network,
    persisted: false,
    verify_url: `https://mempool.space/address/${derived.address}`,
    self: `${origin}/api/invoices/${invoiceId}`,
    metadata,
  });
}
