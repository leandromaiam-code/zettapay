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
import { buildRequestLogger } from './middleware/request-logger.js';
import { logger } from './lib/logger.js';
import express, { type Express, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { openDatabase } from "./db/index.js";
import { healthRouter } from "./routes/health.js";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { SolanaService } from "./services/solana.js";
import { getServiceInfo } from "./lib/version.js";
import { logger } from "./lib/logger.js";
import { loadEnv, type AppEnv } from "./config/env.js";

export interface AppDependencies {
  db?: Db;
  databasePath?: string;
  solana?: SolanaService;
  env?: AppEnv;
}

export interface AppHandle {
  app: Express;
  db: Db;
  solana: SolanaService;
  env: AppEnv;
}

const startedAt = Date.now();

export function buildApp(deps: AppDependencies = {}): AppHandle {
  const env = deps.env ?? loadEnv();
  const db =
    deps.db ?? openDatabase(deps.databasePath ?? env.databasePath);
  const solana =
    deps.solana ??
    new SolanaService({
      rpcUrl: env.solanaRpcUrl,
      commitment: env.solanaCommitment,
      usdcMintAddress: env.usdcMintAddress,
      payerSecretKey: env.payerSecretKey,
    });

  const app = express();
  app.disable('x-powered-by');
  app.use(buildRequestLogger());
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  const info = getServiceInfo();

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: info.name,
      version: info.version,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      now: new Date().toISOString(),
    });
  });

  app.use(healthRouter());
  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana));

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info("app_ready", {
    service: info.name,
    version: info.version,
    nodeEnv: env.nodeEnv,
  });

  return { app, db, solana, env };
}
