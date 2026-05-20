// Z57: listener health probe. Mempool.space WebSocket reachability + the
// count of invoices the listener should be watching (pending + not expired).
// Persistence reads now go through the StorageAdapter interface — no direct
// supabase coupling in the handler.

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createStorage, type StorageAdapter } from '@zettapay/listener';
import { probeMempoolWs } from '../../_lib/btc-listener.js';

function isSupabaseConfigured(): boolean {
  return Boolean((process.env.SUPABASE_URL ?? '').trim());
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
  const storage: StorageAdapter | null = isSupabaseConfigured() ? createStorage(process.env) : null;
  if (storage) {
    try {
      const pending = await storage.listPendingInvoices({ limit: 500, order: 'desc' });
      subscribedAddresses = pending.length;
      if (pending[0]) lastInvoiceAt = pending[0].expires_at;
    } catch {
      // Best-effort; don't fail the status endpoint on persistence hiccups.
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
