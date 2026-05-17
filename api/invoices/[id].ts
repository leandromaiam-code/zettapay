// Z53: invoice status polling. When Supabase is configured, returns the
// persisted row (status, confirmations, tx_hash). Falls back to the
// `_simulate=` query for the legacy SDK demos when Supabase isn't wired up.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { loadSupabaseConfig, supabase, SupabaseError } from '../_lib/supabase.js';

const INVOICE_ID_RE = /^inv_[0-9a-f]{32}$/;

interface InvoiceRow {
  id: string;
  merchant_id: string;
  chain: string;
  receive_address: string;
  amount_usd: number;
  amount_btc: string | null;
  required_confirmations: number;
  status: string;
  confirmations: number;
  tx_hash: string | null;
  detected_at: string | null;
  confirmed_at: string | null;
  expires_at: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
}

function readInvoiceId(req: VercelRequest): string {
  const raw = req.query?.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === 'string' ? id : '';
}

function readSimulate(req: VercelRequest): string {
  const raw = req.query?._simulate;
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === 'string' ? v.toLowerCase() : '';
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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

  const supabaseCfg = loadSupabaseConfig();
  if (supabaseCfg) {
    try {
      const rows = await supabase.select<InvoiceRow>(
        supabaseCfg,
        'zettapay_invoices',
        { id: invoiceId },
        { limit: 1 },
      );
      const row = rows[0];
      if (!row) {
        res.status(404).json({
          error: { code: 'invoice_not_found', message: `No invoice with id "${invoiceId}"` },
        });
        return;
      }
      res.status(200).json({
        invoice_id: row.id,
        merchant_id: row.merchant_id,
        chain: row.chain,
        receive_address: row.receive_address,
        amount_usd: Number(row.amount_usd),
        amount_btc: row.amount_btc,
        status: row.status,
        confirmations: row.confirmations,
        required_confirmations: row.required_confirmations,
        tx_hash: row.tx_hash,
        detected_at: row.detected_at,
        confirmed_at: row.confirmed_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
        metadata: row.metadata,
      });
      return;
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

  // Dev fallback: simulate-driven response when Supabase isn't configured.
  const sim = readSimulate(req);
  const required = 3;
  let status: 'pending' | 'detected' | 'confirmed' = 'pending';
  let confirmations = 0;
  if (sim === 'detected') {
    status = 'detected';
  } else if (sim === 'confirmed') {
    status = 'confirmed';
    confirmations = required;
  }
  res.status(200).json({
    invoice_id: invoiceId,
    chain: 'btc',
    status,
    confirmations,
    required_confirmations: required,
    tx_hash: status === 'confirmed' ? `0x${'0'.repeat(64)}` : null,
    persisted: false,
  });
}
