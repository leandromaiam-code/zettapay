// Z57: invoice status polling. When the StorageAdapter is configured (i.e.
// SUPABASE_URL is set), returns the persisted row (status, confirmations,
// tx_hash). Falls back to the `_simulate=` query for the legacy SDK demos
// when persistence isn't wired up.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createStorage,
  StoragePersistenceError,
  type StorageAdapter,
} from '@zettapay/listener';

const INVOICE_ID_RE = /^inv_[0-9a-f]{32}$/;

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

function isSupabaseConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? '').trim());
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

  const storage: StorageAdapter | null = isSupabaseConfigured() ? createStorage(process.env) : null;
  if (storage) {
    try {
      const row = await storage.getInvoice(invoiceId);
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
        receive_address: row.receive_address ?? row.address,
        amount_usd: row.amount_usd ?? null,
        amount_btc: row.amount_btc ?? null,
        status: row.status,
        confirmations: row.confirmations ?? null,
        required_confirmations: row.required_confirmations ?? null,
        tx_hash: row.tx_hash,
        detected_at: row.detected_at ?? null,
        confirmed_at: row.confirmed_at ?? null,
        expires_at: row.expires_at,
        created_at: row.created_at,
        metadata: row.metadata ?? null,
      });
      return;
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
