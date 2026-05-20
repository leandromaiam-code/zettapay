// Z57: trigger a test webhook for an invoice. Two modes:
//
//   POST                — sign + (optionally) POST to the merchant's
//                         configured webhook_url. Body of the merchant POST is
//                         JSON; the X-ZettaPay-Signature header is the
//                         hex-encoded HMAC-SHA256 of that body using the
//                         merchant's webhook_secret.
//
//   POST with body.echo=true — skip the outbound POST and just return the
//                              payload + signature so the caller can verify
//                              HMAC locally (used by the acceptance test).
//
// Persistence is mediated by the StorageAdapter interface — no direct
// supabase coupling here.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  createStorage,
  StoragePersistenceError,
  type Invoice,
  type Merchant,
  type StorageAdapter,
} from '@zettapay/listener';
import { signWebhook, verifyWebhook, ZETTAPAY_SIGNATURE_HEADER } from '../../../_lib/hmac.js';

const INVOICE_ID_RE = /^inv_[0-9a-f]{32}$/;

interface BodyShape {
  echo?: boolean;
  amount_btc_override?: string;
  tx_hash_override?: string;
  confirmations_override?: number;
  webhook_url_override?: string;
  webhook_secret_override?: string;
}

function readBody(req: VercelRequest): BodyShape {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body) as BodyShape;
    } catch {
      return {};
    }
  }
  return req.body as BodyShape;
}

function readInvoiceId(req: VercelRequest): string {
  const raw = req.query?.invoiceId;
  const id = Array.isArray(raw) ? raw[0] : raw;
  return typeof id === 'string' ? id : '';
}

function isSupabaseConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? '').trim());
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST only' } });
    return;
  }

  const invoiceId = readInvoiceId(req);
  if (!INVOICE_ID_RE.test(invoiceId)) {
    res.status(400).json({
      error: { code: 'invalid_invoice_id', message: 'Invoice id must match inv_<32hex>' },
    });
    return;
  }

  const body = readBody(req);
  const storage: StorageAdapter | null = isSupabaseConfigured() ? createStorage(process.env) : null;

  let invoice: Invoice | null = null;
  let merchant: Merchant | null = null;

  if (storage) {
    try {
      invoice = await storage.getInvoice(invoiceId);
      if (invoice) {
        merchant = await storage.getMerchant(invoice.merchant_id);
      }
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

  const receiveAddress = invoice?.receive_address ?? invoice?.address ?? 'bc1qsynthetic';
  const chain = invoice?.chain ?? 'btc';
  const amountUsd = invoice?.amount_usd ?? 10;
  const amountBtc = invoice?.amount_btc ?? '0.00010000';
  const requiredConfs = invoice?.required_confirmations ?? 1;
  const txHashFromInvoice = invoice?.tx_hash ?? '0'.repeat(64);
  const confirmationsFromInvoice = invoice?.confirmations ?? 1;
  const merchantIdForPayload = invoice?.merchant_id ?? '00000000-0000-0000-0000-000000000000';

  const payload = {
    invoice_id: invoice?.id ?? invoiceId,
    merchant_id: merchantIdForPayload,
    chain,
    receive_address: receiveAddress,
    amount_usd: Number(amountUsd),
    amount_btc: body.amount_btc_override ?? amountBtc,
    tx_hash: body.tx_hash_override ?? txHashFromInvoice,
    confirmations: body.confirmations_override ?? confirmationsFromInvoice,
    required_confirmations: requiredConfs,
    event_type: 'invoice.confirmed.test',
    timestamp: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);

  const merchantSecret = merchant?.webhook_secret_hash || null;
  const secret =
    body.webhook_secret_override ?? merchantSecret ?? 'whsec_dev_fallback_secret';
  const signature = signWebhook(secret, rawBody);

  const webhookUrl = body.webhook_url_override ?? merchant?.webhook_url ?? null;
  let delivered: { status: number; ok: boolean; body: string } | null = null;
  if (!body.echo && webhookUrl) {
    try {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          [ZETTAPAY_SIGNATURE_HEADER]: signature,
        },
        body: rawBody,
      });
      const text = await response.text();
      delivered = { status: response.status, ok: response.ok, body: text.slice(0, 1024) };
    } catch (err) {
      delivered = { status: 0, ok: false, body: (err as Error).message };
    }
  }

  const verifier_check = verifyWebhook(secret, rawBody, signature);

  res.status(200).json({
    invoice_id: payload.invoice_id,
    signature_header: ZETTAPAY_SIGNATURE_HEADER,
    signature,
    payload,
    raw_body: rawBody,
    verifier_check,
    delivered,
    used_persisted_merchant: Boolean(merchant),
  });
}
