import express, { type Express, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { settlementRouter } from "./routes/settlement.js";
import { shopifyRouter } from "./routes/shopify.js";
import { subscriptionsRouter } from "./routes/subscriptions.js";
import { verifySignatureRouter } from "./routes/verify-signature.js";
import { woocommerceRouter } from "./routes/woocommerce.js";
import { errorHandler } from "./middleware/error.js";
import { HttpError } from "./lib/errors.js";
import type { GracefulShutdown } from "./lib/shutdown.js";
import type { SolanaService } from "./services/solana.js";
import type { CreatePaymentDeps } from "./services/payments.js";
import type { CoinflowClient } from "./coinflow/client.js";
import type {
  ShopifyAppConfig,
  ShopifyTokenExchanger,
} from "./services/shopify.js";

export interface CreateAppOptions {
  db: Db;
  solana: SolanaService;
  shutdown?: GracefulShutdown;
  /** Optional Coinflow client. When provided, /merchants/:id/settlement/coinflow
   * routes are mounted and merchants with auto-settle enabled have completed
   * payments automatically swept to USD. */
  coinflow?: CoinflowClient;
  /** Hook fired after auto-settle finishes (success or swallowed error). Test seam. */
  onAutoSettle?: CreatePaymentDeps["onAutoSettle"];
  /** When provided, /shopify/install + /shopify/callback are mounted with
   * full OAuth handling. The /shopify/snippet route is always mounted. */
  shopify?: ShopifyAppConfig | null;
  /** Test seam — replaces the Shopify token exchange HTTP call. */
  shopifyTokenExchanger?: ShopifyTokenExchanger;
}

const startedAt = Date.now();

export function createApp(options: CreateAppOptions): Express {
  const {
    db,
    solana,
    shutdown,
    coinflow,
    onAutoSettle,
    shopify,
    shopifyTokenExchanger,
  } = options;

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
    if (shutdown?.isShuttingDown()) {
      res
        .status(503)
        .json({ status: "draining", inflight: shutdown.inflightCount() });
      return;
    }
    res.json({ status: "ok" });
  });

  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana, { coinflow, onAutoSettle }));
  app.use(subscriptionsRouter(db));
  app.use(verifySignatureRouter(db));
  app.use(
    shopifyRouter(db, {
      config: shopify ?? null,
      ...(shopifyTokenExchanger ? { exchangeToken: shopifyTokenExchanger } : {}),
      ...(shopify?.appUrl ? { publicAppUrl: shopify.appUrl } : {}),
    }),
  );
  app.use(
    woocommerceRouter(db, {
      ...(shopify?.appUrl ? { publicAppUrl: shopify.appUrl } : {}),
    }),
  );
  if (coinflow) {
    app.use(settlementRouter(db, coinflow));
  }

  app.use((_req, _res, next) => {
    next(HttpError.notFound("route not found"));
  });

  app.use(errorHandler);

  return app;
}
