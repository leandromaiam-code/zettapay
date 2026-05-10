import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from './_lib/sentry.js';

function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200).json({
    name: 'zettapay',
    version: '0.1.0',
    description: 'Universal Solana payment protocol for humans and AI agents',
    endpoints: {
      health: '/health',
      healthz: '/healthz',
      ready: '/ready',
      metrics: '/metrics',
      simulate: '/simulate/:merchant',
      analytics: '/analytics/:merchant',
      merchantsRegister: '/merchants/register',
      merchantsOnboard: '/merchants/onboard',
      pay: '/pay',
      mcp: '/mcp',
      onramp: '/onramp',
      onrampWebhook: '/onramp/webhook',
      payments: '/payments',
      faucet: '/api/faucet',
    },
    network: 'solana-devnet',
    runtime: 'vercel-serverless',
  });
}

export default withSentry(handler);
