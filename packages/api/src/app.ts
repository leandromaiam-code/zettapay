import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { openDb, type DB } from './db.js';
import { MerchantRepository } from './repository.js';
import { PaymentLog } from './payments.js';
import { buildMerchantsRouter } from './routes/merchants.js';
import { buildPayRouter } from './routes/pay.js';
import { buildMcpRouter } from './routes/mcp.js';
import { buildOnrampRouter } from './routes/onramp.js';
import { HttpError } from './errors.js';
import type { OnrampNotifierOptions } from './onramp.js';
import type { dispatchWebhook } from './webhook.js';

export interface AppDependencies {
  db?: DB;
  dbPath?: string;
  payments?: PaymentLog;
  onrampWebhookSecret?: string;
  onrampNotify?: OnrampNotifierOptions;
  onrampDispatch?: typeof dispatchWebhook;
  onrampSignatureToleranceMs?: number;
}

export interface AppHandle {
  app: Express;
  db: DB;
  repository: MerchantRepository;
  payments: PaymentLog;
  moonPay: MoonPayConfig | null;
}

function resolveMoonPayConfig(deps: AppDependencies): MoonPayConfig | null {
  if (deps.moonPay !== undefined) return deps.moonPay;
  try {
    return loadMoonPayConfig();
  } catch (err) {
    if (err instanceof MoonPayConfigError) return null;
    throw err;
  }
}

export function buildApp(deps: AppDependencies = {}): AppHandle {
  const db = deps.db ?? openDb({ filename: deps.dbPath });
  const repository = new MerchantRepository(db);
  const payments = deps.payments ?? new PaymentLog();
  const moonPay = resolveMoonPayConfig(deps);

  const app = express();
  app.disable('x-powered-by');

  app.use(
    '/onramp',
    buildOnrampRouter({
      payments,
      webhookSecret: deps.onrampWebhookSecret ?? process.env.MOONPAY_WEBHOOK_SECRET,
      notify:
        deps.onrampNotify ??
        (process.env.MERCHANT_WEBHOOK_URL
          ? {
              url: process.env.MERCHANT_WEBHOOK_URL,
              secret: process.env.MERCHANT_WEBHOOK_SECRET,
            }
          : undefined),
      dispatch: deps.onrampDispatch,
      signatureToleranceMs: deps.onrampSignatureToleranceMs,
    }),
  );

  app.use(express.json({ limit: '64kb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', merchants: repository.count(), payments: payments.count() });
  });

  app.use('/merchants', buildMerchantsRouter(repository));
  app.use('/pay', buildPayRouter(payments));
  app.use('/mcp', buildMcpRouter({ merchants: repository, payments, moonPay }));
  if (moonPay) {
    app.use('/onramp', buildOnrampRouter({ merchants: repository, config: moonPay }));
  } else {
    app.use('/onramp', (_req, res) => {
      res.status(503).json({
        error: {
          code: 'onramp_disabled',
          message: 'MoonPay onramp is not configured (set MOONPAY_API_KEY)',
        },
      });
    });
  }

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "route not found" } });
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

  return { app, db, repository, payments, moonPay };
}
