import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';
import { fetchStatusSummary } from './_lib/status-source.js';

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const summary = await fetchStatusSummary(req);
  // Premissa #32: status page must be public — keep CORS open so dashboards
  // and merchant integrations can poll without proxying.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=15, s-maxage=15');
  res.status(200).json(summary);
}

export default withSentry(handler);
