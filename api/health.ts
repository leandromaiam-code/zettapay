import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  res.status(200).json({
    status: 'ok',
    service: SERVICE,
    runtime: RUNTIME,
    version: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev',
    uptimeSec: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

export default withSentry(handler);
