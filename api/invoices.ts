// Z53: create a non-custodial invoice. Derives a per-invoice receive address
// from the merchant's stored xpub at m/0/{next_child_index}, atomically
// increments the index, and persists the invoice row to Supabase.
//
// Confirmation policy (mission spec, btc-confirmations.ts): 1 conf <$50,
// 3 conf <$500, 6 conf ≥$500. The listener flips status pending → detected
// → confirmed and fires the webhook when the threshold is crossed.

import { randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deriveBip84Receive, parseMerchantXpub, XpubValidationError } from './_lib/xpub.js';
import { loadSupabaseConfig, supabase, SupabaseError } from './_lib/supabase.js';
import { usdToBtc, getBtcUsdSpot } from './_lib/btc-pricing.js';
import { requiredConfirmations } from './_lib/btc-confirmations.js';

const SUPPORTED_CHAINS = ['btc'] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

const MIN_AMOUNT_USD = 0.01;
const MAX_AMOUNT_USD = 1_000_000;
const DEFAULT_TTL_SECONDS = 1_800; // 30 min — spec default
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_METADATA_BYTES = 4 * 1024;

interface MerchantRow {
  id: string;
  xpub: string;
}

interface InvoiceRow {
  id: string;
  merchant_id: string;
  chain: string;
  child_index: number;
  receive_address: string;
  amount_usd: number;
  amount_btc: string | null;
  required_confirmations: number;
  status: string;
  metadata: Record<string, unknown> | null;
  expires_at: string;
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
  const supabaseCfg = loadSupabaseConfig();

  let merchantXpub: string | null = null;
  let resolvedMerchantId = merchantId;
  let childIndex: number | null = null;

  // Path 1: persistent — look up the merchant + atomically allocate the next
  // child index via the SECURITY DEFINER function.
  if (supabaseCfg && merchantId) {
    try {
      const rows = await supabase.select<MerchantRow>(
        supabaseCfg,
        'zettapay_merchants',
        { id: merchantId },
        { select: 'id,xpub', limit: 1 },
      );
      if (rows.length === 0) {
        badRequest(res, 'merchant_not_found', `No merchant with id "${merchantId}"`);
        return;
      }
      merchantXpub = rows[0]!.xpub;
      childIndex = await supabase.rpc<number>(supabaseCfg, 'zettapay_allocate_child_index', {
        p_merchant: merchantId,
      });
    } catch (err) {
      if (err instanceof SupabaseError) {
        res.status(502).json({
          error: { code: 'persistence_failed', message: err.message },
        });
        return;
      }
      throw err;
    }
  }

  // Path 2: dev fallback — caller supplies xpub directly. Index defaults to
  // 0 (or the caller can pass `child_index` for determinism). Useful for
  // the acceptance test and SDK demos without a Supabase project.
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
    // Defensive: at this point either the RPC or the dev fallback should
    // have set childIndex. If neither did, fail loudly.
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

  // Persist when possible. Failure to persist isn't fatal in dev (we degrade
  // to in-memory), but in prod the Supabase config will be present and any
  // failure surfaces as 502.
  let persisted = false;
  if (supabaseCfg && resolvedMerchantId.length === 36) {
    try {
      const inserted = await supabase.insertReturning<InvoiceRow>(
        supabaseCfg,
        'zettapay_invoices',
        {
          id: invoiceId,
          merchant_id: resolvedMerchantId,
          chain,
          child_index: childIndex,
          receive_address: derived.address,
          amount_usd: amountUsd,
          amount_btc: amountBtc,
          required_confirmations: required,
          status: 'pending',
          metadata: metadata ?? null,
          expires_at: expiresIso,
        },
      );
      persisted = true;
      // Use the persisted values so we surface DB-normalized timestamps.
      res.status(201).json({
        invoice_id: inserted.id,
        merchant_id: inserted.merchant_id,
        chain: inserted.chain,
        child_index: inserted.child_index,
        derivation_path: derived.path,
        receive_address: inserted.receive_address,
        amount_usd: Number(inserted.amount_usd),
        amount_btc: inserted.amount_btc ?? amountBtc,
        required_confirmations: inserted.required_confirmations,
        status: inserted.status,
        qr_uri: qrUri,
        expires_at: inserted.expires_at,
        spot_btc_usd: await getBtcUsdSpot(),
        network: derived.network,
        persisted,
        verify_url: `https://mempool.space/address/${inserted.receive_address}`,
        self: `${origin}/api/invoices/${inserted.id}`,
        metadata: inserted.metadata,
      });
      return;
    } catch (err) {
      // Surface a clear 502 — invoice address has been derived but couldn't be persisted.
      res.status(502).json({
        error: {
          code: 'invoice_persist_failed',
          message: err instanceof Error ? err.message : 'unknown supabase error',
        },
        invoice_id: invoiceId,
        receive_address: derived.address,
      });
      return;
    }
  }

  // Dev fallback response — no DB.
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
