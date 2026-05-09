import express, { type Express, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { verifySignatureRouter } from "./routes/verify-signature.js";
import { errorHandler } from "./middleware/error.js";
import { HttpError } from "./lib/errors.js";
import type { SolanaService } from "./services/solana.js";

export interface CreateAppOptions {
  db: Db;
  solana: SolanaService;
}

const startedAt = Date.now();

export function createApp(options: CreateAppOptions): Express {
  const { db, solana } = options;

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "256kb" }));

  app.get("/", (_req: Request, res: Response) => {
    res.json({
      status: "ok",
      service: "@zettapay/api",
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      now: new Date().toISOString(),
    });
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana));
  app.use(verifySignatureRouter(db));

  app.use((_req, _res, next) => {
    next(HttpError.notFound("route not found"));
  });

  app.use(errorHandler);

  return app;
}
