// POST /admin/invoices (Z45 — HD wallet per-invoice foundation)
//
// Creates an invoice row, allocates the next derivation index atomically,
// derives the BIP-84 (BTC) or BIP-44 (EVM) receive address, and returns a
// wallet-less checkout URI. Protected by ZETTAPAY_ADMIN_API_KEY.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from '../_lib/sentry.js';
import { checkAdminAuth, rejectAdmin } from '../_lib/admin-auth.js';
import { getKeyManager } from '../_lib/key-manager.js';
import { getSupabaseAdmin } from '../_lib/supabase.js';
import { buildInvoiceUri, defaultRequiredConfirmations } from '../_lib/invoice-uri.js';
import type { InvoiceChain } from '../_lib/hd-wallet.js';

const SUPPORTED_CHAINS = new Set<InvoiceChain>(['btc', 'base', 'polygon', 'ethereum']);
const DEFAULT_TTL_SECONDS = 30 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MIN_TTL_SECONDS = 60;
const MAX_AMOUNT_USD = 1_000_000;

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  res.status(400).json({ error: { code, message } } satisfies ErrorBody);
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      endpoint: '/admin/invoices',
      method: 'POST',
      auth: 'Bearer <ZETTAPAY_ADMIN_API_KEY> (or X-Admin-Api-Key)',
      body: {
        merchant_id: 'string (required)',
        amount_usd: 'number (required, > 0, <= 1_000_000)',
        chain: "'btc' | 'base' | 'polygon' | 'ethereum'",
        amount_native:
          'string decimal (required for btc; defaults to amount_usd for USDC chains)',
        ttl_seconds: 'integer (optional, 60..86400, default 1800)',
        required_confirmations: 'integer (optional, defaults per chain)',
      },
      responses: {
        '201': '{ invoice_id, receive_address, amount_native, expires_at, qr_uri, derivation_path }',
        '400': 'invalid input',
        '401': 'missing/invalid admin key',
        '503': 'master seed or Supabase not configured',
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res
      .status(405)
      .json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const auth = checkAdminAuth(req);
  if (!auth.ok) {
    rejectAdmin(res, auth);
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const merchantId =
    typeof body.merchant_id === 'string' ? body.merchant_id.trim() : '';
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(merchantId)) {
    return badRequest(res, 'invalid_merchant_id', 'merchant_id must be 3..64 chars [a-zA-Z0-9_-]');
  }

  const amountUsdRaw = body.amount_usd;
  const amountUsd =
    typeof amountUsdRaw === 'number'
      ? amountUsdRaw
      : typeof amountUsdRaw === 'string'
        ? Number.parseFloat(amountUsdRaw)
        : NaN;
  if (!Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > MAX_AMOUNT_USD) {
    return badRequest(
      res,
      'invalid_amount_usd',
      `amount_usd must be a number in (0, ${MAX_AMOUNT_USD}]`,
    );
  }

  const chainRaw = typeof body.chain === 'string' ? body.chain.toLowerCase() : '';
  if (!SUPPORTED_CHAINS.has(chainRaw as InvoiceChain)) {
    return badRequest(
      res,
      'invalid_chain',
      `chain must be one of ${Array.from(SUPPORTED_CHAINS).join(', ')}`,
    );
  }
  const chain = chainRaw as InvoiceChain;

  let amountNative: string;
  if (chain === 'btc') {
    const raw = body.amount_native;
    if (typeof raw !== 'string' || !/^\d+(\.\d{1,8})?$/.test(raw) || Number.parseFloat(raw) <= 0) {
      return badRequest(
        res,
        'missing_amount_native',
        'amount_native (string, max 8 decimals) is required for chain=btc',
      );
    }
    amountNative = raw;
  } else {
    // USDC stablecoins peg ~1:1 to USD. The foundation mission does not own
    // an FX oracle — invoices for non-USDC EVM assets are out of scope.
    amountNative = formatUsdcAmount(amountUsd);
  }

  const ttlSecondsRaw = body.ttl_seconds;
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (ttlSecondsRaw !== undefined && ttlSecondsRaw !== null) {
    const parsed =
      typeof ttlSecondsRaw === 'number'
        ? ttlSecondsRaw
        : typeof ttlSecondsRaw === 'string'
          ? Number.parseInt(ttlSecondsRaw, 10)
          : NaN;
    if (!Number.isInteger(parsed) || parsed < MIN_TTL_SECONDS || parsed > MAX_TTL_SECONDS) {
      return badRequest(
        res,
        'invalid_ttl_seconds',
        `ttl_seconds must be an integer in [${MIN_TTL_SECONDS}, ${MAX_TTL_SECONDS}]`,
      );
    }
    ttlSeconds = parsed;
  }

  const reqConfRaw = body.required_confirmations;
  let requiredConfirmations = defaultRequiredConfirmations(chain);
  if (reqConfRaw !== undefined && reqConfRaw !== null) {
    const parsed =
      typeof reqConfRaw === 'number'
        ? reqConfRaw
        : typeof reqConfRaw === 'string'
          ? Number.parseInt(reqConfRaw, 10)
          : NaN;
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 200) {
      return badRequest(
        res,
        'invalid_required_confirmations',
        'required_confirmations must be an integer in [0, 200]',
      );
    }
    requiredConfirmations = parsed;
  }

  const client = getSupabaseAdmin();
  if (!client) {
    res.status(503).json({
      error: {
        code: 'supabase_unconfigured',
        message: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set',
      },
    });
    return;
  }

  const keyManager = await getKeyManager();
  if (!keyManager) {
    res.status(503).json({
      error: {
        code: 'key_manager_unconfigured',
        message: 'master seed unavailable (Supabase Vault + ZETTAPAY_MASTER_SEED both empty)',
      },
    });
    return;
  }

  let derived;
  try {
    derived = await keyManager.deriveNext(chain);
  } catch (err) {
    // Redact — derivation failures must never leak the seed or BIP-32 state.
    const message = err instanceof Error ? err.message : 'unknown derivation error';
    res
      .status(500)
      .json({ error: { code: 'derivation_failed', message: redactSecrets(message) } });
    return;
  }

  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const { data, error } = await client
    .from('zettapay_invoices')
    .insert({
      merchant_id: merchantId,
      amount_usd: amountUsd,
      amount_native: amountNative,
      chain,
      derivation_path: derived.path,
      derivation_index: derived.index,
      receive_address: derived.address,
      status: 'pending',
      confirmations: 0,
      required_confirmations: requiredConfirmations,
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();

  if (error || !data) {
    res.status(500).json({
      error: {
        code: 'invoice_insert_failed',
        message: error?.code === '23503'
          ? 'merchant_id not registered'
          : `database write failed (${error?.code ?? 'unknown'})`,
      },
    });
    return;
  }

  const qrUri = buildInvoiceUri({
    chain,
    address: derived.address,
    amountNative,
  });

  res.status(201).json({
    invoice_id: data.id,
    receive_address: derived.address,
    derivation_path: derived.path,
    amount_native: amountNative,
    expires_at: data.expires_at,
    qr_uri: qrUri,
    chain,
    required_confirmations: requiredConfirmations,
  });
}

function formatUsdcAmount(amountUsd: number): string {
  // USDC has 6 decimals on every supported chain. Round to 6 decimals,
  // never up (avoid silently inflating the invoice).
  return (Math.floor(amountUsd * 1_000_000) / 1_000_000).toFixed(6);
}

function redactSecrets(message: string): string {
  // Strip anything that resembles a BIP-39 word sequence or extended key.
  return message
    .replace(/\b[xyz]p[ru]b[1-9A-HJ-NP-Za-km-z]{50,}\b/g, '<redacted-xpub>')
    .replace(/(\b[a-z]{3,8}\b\s+){5,}[a-z]{3,8}\b/gi, '<redacted-mnemonic>');
}

export default withSentry(handler);
