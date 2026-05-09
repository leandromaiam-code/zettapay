type OutboundEvent =
  | 'hipotese.approved'
  | 'hipotese.rejected'
  | 'premissas.updated'
  | 'workspace.created';

interface OutboundPayload {
  event: OutboundEvent;
  workspace: { id: string; slug: string };
  [key: string]: unknown;
}

export async function notifyN8n(payload: OutboundPayload): Promise<void> {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) {
    console.info('[n8n] N8N_WEBHOOK_URL ausente — evento ignorado:', payload.event);
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn('[n8n] webhook respondeu', res.status, await res.text());
    }
  } catch (err) {
    console.warn('[n8n] falha ao despachar webhook:', err);
  }
}
