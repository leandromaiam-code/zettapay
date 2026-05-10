import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(_req: VercelRequest, res: VercelResponse): void {
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
    },
    network: 'solana-devnet',
    runtime: 'vercel-serverless',
  });
}
