import { Router, type Request, type Response } from 'express';
import { getClusterHealth } from '../services/solana.js';
import { logger } from '../utils/logger.js';

export const healthRouter: Router = Router();

healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({ status: 'ok', service: 'zettapay', timestamp: new Date().toISOString() });
});

healthRouter.get('/solana', async (_req: Request, res: Response) => {
  try {
    const health = await getClusterHealth();
    res.json({ status: 'ok', ...health });
  } catch (err) {
    logger.error({ err }, 'Solana health check failed');
    res.status(503).json({ status: 'error', message: 'Solana RPC unreachable' });
  }
});
