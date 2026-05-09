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
import {
  apiKeyResolver,
  ipResolver,
  rateLimit,
} from "./middleware/rate-limit.js";
import { SolanaService } from "./services/solana.js";
import { getServiceInfo } from "./lib/version.js";
import { logger } from "./lib/logger.js";
import {
  MemoryRateLimitStore,
  type RateLimitStore,
} from "./lib/rate-limit-store.js";
import { createRedisRateLimitStore } from "./lib/rate-limit-redis.js";
import { loadEnv, type AppEnv } from "./config/env.js";

export interface AppDependencies {
  db?: Db;
  databasePath?: string;
  solana?: SolanaService;
  env?: AppEnv;
=======
  rateLimitStore?: RateLimitStore;
>>>>>>> f04ee59 (feat(api): rate limiting per API key + native DDoS guard (Redis sliding window))
}

export interface AppHandle {
  app: Express;
  db: Db;
  solana: SolanaService;
  env: AppEnv;
<<<<<<< HEAD
}

const startedAt = Date.now();

export function buildApp(deps: AppDependencies = {}): AppHandle {
  rateLimitStore: RateLimitStore;
}

const startedAt = Date.now();

const RATE_LIMIT_FREE_PATHS = new Set(["/", "/health", "/healthz"]);

function isRateLimitFree(req: Request): boolean {
  return RATE_LIMIT_FREE_PATHS.has(req.path);
}

async function resolveRateLimitStore(
  env: AppEnv,
  override: RateLimitStore | undefined,
): Promise<RateLimitStore> {
  if (override) return override;
  if (!env.redisUrl) return new MemoryRateLimitStore({ gcIntervalMs: 60_000 });
  try {
    const store = await createRedisRateLimitStore(env.redisUrl, {
      keyPrefix: "zettapay:rl:",
    });
    logger.info("rate_limit_store_redis", { url: redactRedisUrl(env.redisUrl) });
    return store;
  } catch (err) {
    logger.error("rate_limit_redis_unavailable", {
      url: redactRedisUrl(env.redisUrl),
      message: err instanceof Error ? err.message : String(err),
    });
    return new MemoryRateLimitStore({ gcIntervalMs: 60_000 });
  }
}

function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "redis://***";
  }
}

export async function buildApp(
  deps: AppDependencies = {},
): Promise<AppHandle> {
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
=======
  const rateLimitStore = await resolveRateLimitStore(env, deps.rateLimitStore);
>>>>>>> f04ee59 (feat(api): rate limiting per API key + native DDoS guard (Redis sliding window))

  const app = express();
  app.disable('x-powered-by');
  app.use(buildRequestLogger());
  app.disable("x-powered-by");
<<<<<<< HEAD
  app.set("trust proxy", true);
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
  });

  app.use(healthRouter());

  if (!env.rateLimitDisabled) {
    app.use(
      rateLimit({
        store: rateLimitStore,
        max: env.rateLimitIpMax,
        windowMs: env.rateLimitIpWindowMs,
        keyResolver: ipResolver,
        scope: "ip",
        skip: isRateLimitFree,
      }),
    );
    app.use(
      rateLimit({
        store: rateLimitStore,
        max: env.rateLimitMax,
        windowMs: env.rateLimitWindowMs,
        keyResolver: apiKeyResolver,
        scope: "api",
        skip: isRateLimitFree,
      }),
    );
  }

  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana));

  app.use(notFoundHandler);
  app.use(errorHandler);

  logger.info("app_ready", {
    service: info.name,
    version: info.version,
    nodeEnv: env.nodeEnv,
    rateLimit: env.rateLimitDisabled
      ? "disabled"
      : {
          apiMax: env.rateLimitMax,
          apiWindowMs: env.rateLimitWindowMs,
          ipMax: env.rateLimitIpMax,
          ipWindowMs: env.rateLimitIpWindowMs,
          store: env.redisUrl ? "redis" : "memory",
        },
  });

  return { app, db, solana, env, rateLimitStore };
}
