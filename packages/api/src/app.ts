import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { openDb, type DB } from './db.js';
import { MerchantRepository } from './repository.js';
import { PaymentLog } from './payments.js';
import { buildMerchantsRouter } from './routes/merchants.js';
import { buildPayRouter } from './routes/pay.js';
import { buildPaymentsRouter } from './routes/payments.js';
import { buildMcpRouter } from './routes/mcp.js';
import { HttpError } from './errors.js';

export interface AppDependencies {
  db?: DB;
  dbPath?: string;
  payments?: PaymentLog;
}

export interface AppHandle {
  app: Express;
  db: DB;
  repository: MerchantRepository;
  payments: PaymentLog;
}

export function buildApp(deps: AppDependencies = {}): AppHandle {
  const db = deps.db ?? openDb({ filename: deps.dbPath });
  const repository = new MerchantRepository(db);
  const payments = deps.payments ?? new PaymentLog();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', merchants: repository.count(), payments: payments.count() });
  });

  app.use('/merchants', buildMerchantsRouter(repository));
  app.use('/pay', buildPayRouter(payments));
  app.use('/payments', buildPaymentsRouter(payments));
  app.use('/mcp', buildMcpRouter({ merchants: repository, payments }));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'route not found' } });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    const message = err instanceof Error ? err.message : 'internal error';
    res.status(500).json({ error: { code: 'internal_error', message } });
  });

  return { app, db, repository, payments };
}
