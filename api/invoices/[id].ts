import type { VercelRequest, VercelResponse } from '@vercel/node';

const SUPPORTED_CHAINS = ['btc', 'base', 'polygon', 'ethereum'] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

const INVOICE_ID_RE = /^inv_[0-9a-f]{32}$/;

const REQUIRED_CONFIRMATIONS: Record<Chain, number> = {
  btc: 3,
  base: 1,
  polygon: 5,
  ethereum: 12,
};

function isSupportedChain(value: unknown): value is Chain {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function readInvoiceId(req: VercelRequest): string {
  const raw = req.query?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === 'string' ? id : '';
}

function readChainHint(req: VercelRequest): Chain | null {
  const raw = req.query?.chain;
  const c = Array.isArray(raw) ? raw[0] : raw;
  return isSupportedChain(c) ? c : null;
}

function readSimulate(req: VercelRequest): string {
  const raw = req.query?._simulate;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.toLowerCase() : '';
}

/**
 * GET /api/invoices/:id — status polling endpoint used by the hosted checkout.
 *
 * Persistence is not yet wired into this Vercel function (the on-chain
 * listeners write to Supabase out-of-band). Until the listener pipeline is
 * surfaced here, we return a deterministic "pending" view of the invoice so
 * the checkout UI can render the awaiting-payment state.
 *
 * Tests/demo flows can drive the state machine via ?_simulate=detected|confirmed.
 */
export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const invoiceId = readInvoiceId(req);
  if (!INVOICE_ID_RE.test(invoiceId)) {
    res.status(400).json({
      error: { code: 'invalid_invoice_id', message: 'Invoice id must match inv_<32hex>' },
    });
    return;
  }

  const chainHint = readChainHint(req);
  const required = chainHint ? REQUIRED_CONFIRMATIONS[chainHint] : 3;

  const sim = readSimulate(req);
  let status: 'pending' | 'detected' | 'confirmed' = 'pending';
  let confirmations = 0;
  if (sim === 'detected') {
    status = 'detected';
    confirmations = 0;
  } else if (sim === 'confirmed') {
    status = 'confirmed';
    confirmations = required;
  }

  res.status(200).json({
    invoice_id: invoiceId,
    chain: chainHint,
    status,
    confirmations,
    required_confirmations: required,
    tx_hash: status === 'confirmed' ? `0x${'0'.repeat(64)}` : null,
  });
}
