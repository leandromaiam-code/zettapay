import express, { type Express, type Request, type Response } from "express";
import type { IncomingMessage } from "node:http";
import type { Database as Db } from "better-sqlite3";
import { agentIdentityRouter } from "./routes/agent-identity.js";
import { agentSpendingLimitsRouter } from "./routes/agent-spending-limits.js";
import { agentToAgentRouter } from "./routes/agent-to-agent.js";
import { amlRouter } from "./routes/aml.js";
import { ambassadorsRouter } from "./routes/ambassadors.js";
import { analyticsRouter } from "./routes/analytics.js";
import { apiDocsRouter } from "./routes/api-docs.js";
import { betaRouter } from "./routes/beta.js";
import { loadBetaConfig, type BetaLaunchConfig } from "./beta/config.js";
import { funnelRouter } from "./routes/funnel.js";
import { healthRouter } from "./routes/health.js";
import { indexerRouter } from "./routes/indexer.js";
import { incidentsRouter } from "./routes/incidents.js";
import { kycRouter } from "./routes/kyc.js";
import { mcpRegistryRouter } from "./routes/mcp-registry.js";
import { merchantsRouter } from "./routes/merchants.js";
import { payRouter } from "./routes/pay.js";
import { paymentRouter } from "./routes/payment.js";
import { refundRouter } from "./routes/refund.js";
import { privacyRouter } from "./routes/privacy.js";
import { registryRouter } from "./routes/registry.js";
import { payEvmRouter } from "./routes/pay_evm.js";
import { riskRouter } from "./routes/risk.js";
import { settlementRouter } from "./routes/settlement.js";
import { shopifyRouter } from "./routes/shopify.js";
import { statusPageRouter } from "./routes/status-page.js";
import { subscriptionsRouter } from "./routes/subscriptions.js";
import { subscriptionManageRouter } from "./routes/subscription-manage.js";
import { treasuryRouter } from "./routes/treasury.js";
import { pixRouter, type PixClientResolver } from "./routes/pix.js";
import { bridgeRouter } from "./routes/bridge.js";
import { verifySignatureRouter } from "./routes/verify-signature.js";
import { webflowRouter } from "./routes/webflow.js";
import { webhooksAdminRouter } from "./routes/webhooks-admin.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { wixRouter } from "./routes/wix.js";
import { woocommerceRouter } from "./routes/woocommerce.js";
import { wordpressRouter } from "./routes/wordpress.js";
import { errorHandler } from "./middleware/error.js";
import { metricsMiddleware } from "./middleware/metrics.js";
import { securityHeaders } from "./middleware/security-headers.js";
import { incidentGuard } from "./middleware/incident-guard.js";
import { IncidentService } from "./services/incident.js";
import { HttpError } from "./lib/errors.js";
import { isSentryEnabled, Sentry } from "./lib/sentry.js";
import type { GracefulShutdown } from "./lib/shutdown.js";
import type { SolanaService } from "./services/solana.js";
import type { CreatePaymentDeps } from "./services/payments.js";
import type { CoinflowClient } from "./coinflow/client.js";
import type { OnChainPaymentIndexer } from "./services/onchain_indexer.js";
import type { KycProviderClient } from "./services/kyc/provider.js";
import { loadAmlConfigFromEnv, type AmlMonitorConfig } from "./services/aml.js";
import type {
  ShopifyAppConfig,
  ShopifyTokenExchanger,
} from "./services/shopify.js";
import { TreasuryService } from "./services/treasury.js";
import type { PixProvider } from "./pix/client.js";
import type { AttestationClient } from "./bridge/attestation.js";
import type { EvmService } from "./services/evm.js";

export interface CreateAppOptions {
  db: Db;
  solana: SolanaService;
  shutdown?: GracefulShutdown;
  /** Optional Coinflow client. When provided, /merchants/:id/settlement/coinflow
   * routes are mounted and merchants with auto-settle enabled have completed
   * payments automatically swept to USD. */
  coinflow?: CoinflowClient;
  /** Pix payout configuration. When `resolveClient` returns a client for the
   * merchant's chosen provider AND the merchant has auto-settle enabled, a
   * BRL Pix payout is fired-and-forgotten after a successful payment. */
  pix?: {
    resolveClient: PixClientResolver;
    availableProviders: readonly PixProvider[];
  };
  /** Hook fired after Coinflow auto-settle finishes (success or swallow). Test seam. */
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
  /** Z10.5 admin dashboard auth — gates the admin webhook events stream.
   * Same pattern as treasury: when omitted or shorter than 24 chars, the
   * routes are mounted but reject every call with config_error. */
  admin?: {
    adminKey?: string | null;
  };
  /** Z9.5 on-chain payment indexer. When `indexer` is omitted, the read API
   * stays live but webhook + backfill routes return config_error. The
   * `webhookAuthKey` is the shared secret presented by Helius/Geyser; same
   * 24-char minimum and config_error fallback as the admin gate. */
  indexer?: {
    webhookAuthKey?: string | null;
    indexer?: OnChainPaymentIndexer;
  };
  /** Hook fired after Pix auto-settle finishes (success or swallow). Test seam. */
  onAutoPixSettle?: CreatePaymentDeps["onAutoPixSettle"];
  /**
   * Optional attestation client (Circle iris by default). When provided,
   * `/bridge/*` routes are mounted so merchants can accept USDC on Base /
   * Polygon and route to Solana via CCTP — see premissa I.1 / Z11.
   */
  attestation?: AttestationClient;
  /** Optional EVM service. When provided, /pay/evm/:merchantRef routes
   * (Base + Polygon ERC-20 USDC) are mounted. Disabled by default. */
  evm?: EvmService;
  /** AML monitoring config override (Z21.2). Defaults to env-loaded config.
   * Pass `null` to disable post-payment AML evaluation. */
  amlConfig?: AmlMonitorConfig | null;
  /** Hook fired after AML evaluation (success or swallowed error). Test seam. */
  onAmlEvaluated?: CreatePaymentDeps["onAmlEvaluated"];
  /** Z22.4 — incident response. Reuses the treasury admin key when no
   * dedicated incident key is supplied; both have the same blast radius
   * (mainnet kill switch). When the key is unset, /admin/incidents/* still
   * mounts but rejects every call, while /status remains public. */
  incidents?: {
    adminKey?: string | null;
  };
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
    admin,
    indexer,
    pix,
    onAutoSettle,
    onAutoPixSettle,
  } = options;
  const betaConfig = options.betaConfig ?? loadBetaConfig();
  const { db, solana, shutdown, coinflow, onAutoSettle, attestation } = options;
  const { db, solana, shutdown, coinflow, onAutoSettle, evm } = options;
    amlConfig,
    onAmlEvaluated,
  } = options;
  const resolvedAmlConfig: AmlMonitorConfig | null =
    amlConfig === undefined ? loadAmlConfigFromEnv() : amlConfig;
    incidents: incidentOptions,
  } = options;
  const incidentService = new IncidentService(db);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(securityHeaders());
  app.use(metricsMiddleware());
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
  app.use(healthRouter({ db, betaConfig }));
  // Z22.4 — kill-switch guard runs before /pay so an active incident short-
  // circuits payment creation with HTTP 503 + Retry-After. Other routes
  // (status, /admin, dashboards) remain reachable so incident commanders can
  // observe and resolve while writes are paused.
  app.post("/pay", incidentGuard(incidentService));
  app.use(agentIdentityRouter(db));
  app.use(agentSpendingLimitsRouter(db));
  app.use(agentToAgentRouter(db, solana));
  app.use(betaRouter(db, betaConfig));
  app.use(merchantsRouter(db));
  app.use(payRouter(db, solana, { coinflow, onAutoSettle, betaConfig }));
  app.use(paymentRouter(db));
  app.use(refundRouter(db, solana));
  app.use(
    payRouter(db, solana, {
      coinflow,
      onAutoSettle,
      amlConfig: resolvedAmlConfig,
      onAmlEvaluated,
    }),
  );
  app.use(payRouter(db, solana, { coinflow, onAutoSettle }));
  app.use(privacyRouter(db));
  app.use(kycRouter(db, kyc ? { provider: kyc } : {}));
  app.use(amlRouter(db));
  app.use(registryRouter(db));
  app.use(riskRouter(db));
  app.use(mcpRegistryRouter(db));
  app.use(subscriptionsRouter(db));
  app.use(subscriptionManageRouter(db));
  app.use(
    payRouter(db, solana, {
      coinflow,
      onAutoSettle,
      pix: pix?.resolveClient,
      onAutoPixSettle,
    }),
  );
  if (evm) {
    app.use(payEvmRouter(db, evm));
  }
  app.use(verifySignatureRouter(db));
  app.use(analyticsRouter(db));
  app.use(funnelRouter(db));
  app.use(webhooksRouter(db));
  app.use(webhooksAdminRouter(db, { adminKey: admin?.adminKey ?? null }));
  app.use(statusPageRouter(db, { adminKey: admin?.adminKey ?? null }));
  app.use(ambassadorsRouter(db, { adminKey: admin?.adminKey ?? null }));
  app.use(
    indexerRouter(db, {
      webhookAuthKey: indexer?.webhookAuthKey ?? null,
      ...(indexer?.indexer ? { indexer: indexer.indexer } : {}),
    }),
  );
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
  if (pix && pix.availableProviders.length > 0) {
    app.use(pixRouter(db, pix));
  if (attestation) {
    app.use(bridgeRouter(db, { attestation, solana }));
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

  app.use(
    incidentsRouter({
      incidents: incidentService,
      adminKey: incidentOptions?.adminKey ?? treasury?.adminKey ?? null,
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
