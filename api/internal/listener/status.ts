// Z53: listener health probe. Mempool.space WebSocket reachability + the
// count of invoices the listener should be watching (pending + not expired).
//
// The long-running BtcListener process is deployed separately (it can't run
// inside a serverless function — Vercel kills connections after the request
// completes). This endpoint answers the question: "from THIS environment, is
// the mempool.space WS reachable, and how many addresses would we be tracking
// right now?" That's the signal the acceptance test needs.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { probeMempoolWs } from '../../_lib/btc-listener.js';
import { loadSupabaseConfig, supabase } from '../../_lib/supabase.js';

interface PendingInvoice {
  id: string;
  receive_address: string;
  expires_at: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const probe = await probeMempoolWs();

  let subscribedAddresses = 0;
  let lastInvoiceAt: string | null = null;
  const supabaseCfg = loadSupabaseConfig();
  if (supabaseCfg) {
    try {
      const pending = await supabase.select<PendingInvoice>(
        supabaseCfg,
        'zettapay_invoices',
        { status: 'pending' },
        { select: 'id,receive_address,expires_at', limit: 500, order: 'created_at.desc' },
      );
      const now = Date.now();
      const live = pending.filter((r) => new Date(r.expires_at).getTime() > now);
      subscribedAddresses = live.length;
      if (pending[0]) lastInvoiceAt = pending[0].expires_at;
    } catch {
      // Best-effort; don't fail the status endpoint on DB hiccups.
    }
  }

  res.status(probe.connected ? 200 : 503).json({
    connected: probe.connected,
    upstream: probe.url,
    latency_ms: probe.latencyMs,
    subscribed_addresses: subscribedAddresses,
    last_invoice_at: lastInvoiceAt,
    last_event_at: probe.connected ? new Date().toISOString() : null,
    ...(probe.error ? { error: probe.error } : {}),
  });
}
