// Z53: trigger a test webhook for an invoice. Two modes:
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
// Persists the event to `zettapay_webhook_events` so the audit trail records
// the manual test.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { signWebhook, verifyWebhook, ZETTAPAY_SIGNATURE_HEADER } from '../../../_lib/hmac.js';
import { loadSupabaseConfig, supabase, SupabaseError } from '../../../_lib/supabase.js';

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
}

interface MerchantRow {
  id: string;
  webhook_url: string | null;
  webhook_secret: string | null;
}

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
  const supabaseCfg = loadSupabaseConfig();

  let invoice: InvoiceRow | null = null;
  let merchant: MerchantRow | null = null;

  if (supabaseCfg) {
    try {
      const invRows = await supabase.select<InvoiceRow>(
        supabaseCfg,
        'zettapay_invoices',
        { id: invoiceId },
        { limit: 1 },
      );
      invoice = invRows[0] ?? null;
      if (invoice) {
        const merchRows = await supabase.select<MerchantRow>(
          supabaseCfg,
          'zettapay_merchants',
          { id: invoice.merchant_id },
          { select: 'id,webhook_url,webhook_secret', limit: 1 },
        );
        merchant = merchRows[0] ?? null;
      }
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

  // Fallback: synthesize an invoice when no DB. Useful for the echo path.
  if (!invoice) {
    invoice = {
      id: invoiceId,
      merchant_id: '00000000-0000-0000-0000-000000000000',
      chain: 'btc',
      receive_address: 'bc1qsynthetic',
      amount_usd: 10,
      amount_btc: '0.00010000',
      required_confirmations: 1,
      status: 'confirmed',
      confirmations: 1,
      tx_hash: body.tx_hash_override ?? '0'.repeat(64),
    };
  }

  const payload = {
    invoice_id: invoice.id,
    merchant_id: invoice.merchant_id,
    chain: invoice.chain,
    receive_address: invoice.receive_address,
    amount_usd: Number(invoice.amount_usd),
    amount_btc: body.amount_btc_override ?? invoice.amount_btc,
    tx_hash: body.tx_hash_override ?? invoice.tx_hash ?? '0'.repeat(64),
    confirmations: body.confirmations_override ?? invoice.confirmations ?? 1,
    required_confirmations: invoice.required_confirmations,
    event_type: 'invoice.confirmed.test',
    timestamp: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);

  const secret =
    body.webhook_secret_override ?? merchant?.webhook_secret ?? 'whsec_dev_fallback_secret';
  const signature = signWebhook(secret, rawBody);

  // Persist the event for audit when DB is configured.
  if (supabaseCfg && merchant) {
    try {
      await supabase.insertReturning(supabaseCfg, 'zettapay_webhook_events', {
        invoice_id: invoice.id,
        merchant_id: invoice.merchant_id,
        event_type: 'invoice.confirmed.test',
        attempt: 0,
        max_attempts: 1,
        payload,
        signature,
        status: body.echo ? 'echoed' : 'pending',
      });
    } catch {
      // Don't fail the test endpoint on audit insert failures.
    }
  }

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

  // Round-trip the verifier so the caller can confirm the HMAC pair is symmetric.
  const verifier_check = verifyWebhook(secret, rawBody, signature);

  res.status(200).json({
    invoice_id: invoice.id,
    signature_header: ZETTAPAY_SIGNATURE_HEADER,
    signature,
    payload,
    raw_body: rawBody,
    verifier_check,
    delivered,
    used_persisted_merchant: Boolean(merchant),
  });
}
