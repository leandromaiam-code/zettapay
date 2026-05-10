import express, { type Express, type Request, type Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Database as Db } from "better-sqlite3";
import { agentIdentityRouter } from "./routes/agent-identity.js";
import { agentSpendingLimitsRouter } from "./routes/agent-spending-limits.js";
import { agentToAgentRouter } from "./routes/agent-to-agent.js";
import { analyticsRouter } from "./routes/analytics.js";
import { apiDocsRouter } from "./routes/api-docs.js";
import { betaRouter } from "./routes/beta.js";
import { loadBetaConfig, type BetaLaunchConfig } from "./beta/config.js";
import { funnelRouter } from "./routes/funnel.js";
import { kycRouter } from "./routes/kyc.js";
import { mcpRegistryRouter } from "./routes/mcp-registry.js";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { registryRouter } from "./routes/registry.js";
import { settlementRouter } from "./routes/settlement.js";
import { shopifyRouter } from "./routes/shopify.js";
import { subscriptionsRouter } from "./routes/subscriptions.js";
import { treasuryRouter } from "./routes/treasury.js";
import { verifySignatureRouter } from "./routes/verify-signature.js";
import { webflowRouter } from "./routes/webflow.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { wixRouter } from "./routes/wix.js";
import { woocommerceRouter } from "./routes/woocommerce.js";
import { wordpressRouter } from "./routes/wordpress.js";
import { errorHandler } from "./middleware/error.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { HttpError } from "./lib/errors.js";
import { isSentryEnabled, Sentry } from "./lib/sentry.js";
import type { GracefulShutdown } from "./lib/shutdown.js";
import type { SolanaService } from "./services/solana.js";
import type { CreatePaymentDeps } from "./services/payments.js";
import type { CoinflowClient } from "./coinflow/client.js";
import type { KycProviderClient } from "./services/kyc/provider.js";
import type {
  ShopifyAppConfig,
  ShopifyTokenExchanger,
} from "./services/shopify.js";
import { TreasuryService } from "./services/treasury.js";

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
  /** When provided, /merchants/:id/kyc/* + /webhooks/sumsub are wired through
   * to a real KYC provider. Without it, those routes 503 with kyc_disabled. */
  kyc?: KycProviderClient;
  /** Treasury/insurance reserve admin endpoints. When `adminKey` is omitted or
   * shorter than 24 chars the routes are still mounted but reject every call
   * with config_error — protects mainnet from accidental open access (Z22.3). */
  treasury?: {
    adminKey?: string | null;
    reserveRatio?: number;
  };
  /** Z22.1 beta launch protocol config. Defaults to env-driven loadBetaConfig().
   * Test seam: pass an override (e.g. { enabled: false }) to bypass the gate. */
  betaConfig?: BetaLaunchConfig;
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
    kyc,
    treasury,
  } = options;
  const betaConfig = options.betaConfig ?? loadBetaConfig();

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(securityHeaders());
  // Capture rawBody on JSON-parsed requests so webhook receivers (e.g. Sumsub)
  // can verify provider-side HMAC signatures over the original bytes — once
  // express.json() runs, re-stringifying the parsed object will not reproduce
  // the canonical payload the provider signed.
  app.use(
    express.json({
      limit: "256kb",
      verify: (req: IncomingMessage, _res, buf: Buffer): void => {
        (req as IncomingMessage & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );

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

  app.use(apiDocsRouter());
  app.use(agentIdentityRouter(db));
  app.use(agentSpendingLimitsRouter(db));
  app.use(agentToAgentRouter(db, solana));
  app.use(betaRouter(db, betaConfig));
  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana, { coinflow, onAutoSettle, betaConfig }));
  app.use(kycRouter(db, kyc ? { provider: kyc } : {}));
  app.use(registryRouter(db));
  app.use(mcpRegistryRouter(db));
  app.use(subscriptionsRouter(db));
  app.use(verifySignatureRouter(db));
  app.use(analyticsRouter(db));
  app.use(funnelRouter(db));
  app.use(webhooksRouter(db));
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
  app.use(
    webflowRouter(db, {
      ...(shopify?.appUrl ? { publicAppUrl: shopify.appUrl } : {}),
    }),
  );
  app.use(
    wordpressRouter(db, {
      ...(shopify?.appUrl ? { publicAppUrl: shopify.appUrl } : {}),
    }),
  );
  app.use(
    wixRouter(db, {
      ...(shopify?.appUrl ? { publicAppUrl: shopify.appUrl } : {}),
    }),
  );
  if (coinflow) {
    app.use(settlementRouter(db, coinflow));
  }

  const treasuryService = new TreasuryService(db, {
    ...(treasury?.reserveRatio !== undefined
      ? { reserveRatio: treasury.reserveRatio }
      : {}),
  });
  app.use(
    treasuryRouter(db, {
      treasury: treasuryService,
      adminKey: treasury?.adminKey ?? null,
    }),
  );

  app.use((_req, _res, next) => {
    next(HttpError.notFound("route not found"));
  });

  if (isSentryEnabled()) {
    Sentry.setupExpressErrorHandler(app, {
      shouldHandleError: (err) => {
        if (err instanceof HttpError) return err.status >= 500;
        return true;
      },
    });
  }

  app.use(errorHandler);

  return app;
}
