// Z51 — WhatsApp alerter for consecutive sweep failures. Fires a single
// outbound POST to WHATSAPP_ALERT_WEBHOOK_URL with a structured payload
// whenever the per-family failure counter hits the threshold. Without the
// webhook configured, the call is a no-op so dev / CI never page anyone.

import type { SweepChain } from './sweep-types.js';

export async function notifyConsecutiveFailures(args: {
  chain: SweepChain;
  consecutive: number;
  lastReason: string;
}): Promise<void> {
  const url = process.env.WHATSAPP_ALERT_WEBHOOK_URL?.trim();
  if (!url) return;
  const body = {
    type: 'sweep.failures',
    chain: args.chain,
    consecutive: args.consecutive,
    lastReason: args.lastReason,
    occurredAt: new Date().toISOString(),
  };
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    // Alerter must not throw — sweep tick proceeds even if paging is down.
  }
}
