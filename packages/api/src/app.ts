import express, { type Express } from "express";
import type { Database as Db } from "better-sqlite3";
import { healthRouter } from "./routes/health.js";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { errorHandler } from "./middleware/error.js";
import type { SolanaService } from "./services/solana.js";

export interface AppDeps {
  db: Db;
  solana: SolanaService;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.use(healthRouter());
  app.use(merchantsRouter(deps.db));
  app.use(payRouter(deps.db, deps.solana));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "route not found" } });
  });

  app.use(errorHandler);
  return app;
}
