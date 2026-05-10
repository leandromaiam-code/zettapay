import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';

function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    status: 'ok',
    service: 'zettapay',
    runtime: 'vercel-serverless',
    timestamp: new Date().toISOString(),
  });
}

export default withSentry(handler);
