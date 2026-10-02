import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';

function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    name: 'zettapay',
    description:
      'Non-custodial crypto payments (BTC, USDC/USDT on Base). This deployment serves the website; payments run on the self-hosted listener or on ZettaPay Cloud.',
    endpoints: {
      health: '/health',
      healthz: '/healthz',
      status: '/api/status',
      openapi: '/openapi.json',
      llms: '/llms.txt',
    },
    runtime: 'vercel-serverless',
  });
}

export default withSentry(handler);
