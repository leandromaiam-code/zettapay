// Tracing must boot before anything else so the auto-instrumentations can
// patch http/express/fetch as those modules are first required below.
import { initTracing } from "./lib/tracing.js";
const tracing = initTracing("zettapay-api");
import "./instrument.js";

import { createApp } from "./app.js";
import {
  HttpCoinflowClient,
  type CoinflowClient,
  type CoinflowEnvironment,
} from "./coinflow/client.js";
import {
  createPixClient,
  isPixProvider,
  PIX_PROVIDERS,
  type PixClient,
  type PixEnvironment,
  type PixProvider,
} from "./pix/client.js";
  HttpAttestationClient,
  type AttestationClient,
  type AttestationEnvironment,
} from "./bridge/attestation.js";
import { closeDatabase, openDatabase } from "./db/index.js";
import type { Cluster } from "./lib/currencies.js";
import { logger } from "./lib/logger.js";
import { GracefulShutdown } from "./lib/shutdown.js";
import { SolanaService } from "./services/solana.js";
import type { ShopifyAppConfig } from "./services/shopify.js";
import { createSumsubClient } from "./services/kyc/sumsub.js";
import type { KycProviderClient } from "./services/kyc/provider.js";
import { EvmService } from "./services/evm.js";

const port = Number.parseInt(process.env.PORT ?? "3001", 10);
const host = process.env.HOST ?? "0.0.0.0";
const shutdownTimeoutMs = Number.parseInt(
  process.env.SHUTDOWN_TIMEOUT_MS ?? "30000",
  10,
);

const db = openDatabase(process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite");

const solana = new SolanaService({
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
  commitment:
    (process.env.SOLANA_COMMITMENT as
      | "processed"
      | "confirmed"
      | "finalized"
      | undefined) ?? "confirmed",
  cluster: parseClusterEnv(process.env.SOLANA_NETWORK ?? process.env.SOLANA_CLUSTER),
  usdcMintAddress: process.env.SOLANA_USDC_MINT ?? null,
  payerSecretKey:
    process.env.SOLANA_FEE_PAYER_SECRET ?? process.env.PAYER_SECRET_KEY ?? null,
});

function parseClusterEnv(raw: string | undefined): Cluster {
  switch ((raw ?? "devnet").toLowerCase()) {
    case "mainnet":
    case "mainnet-beta":
      return "mainnet-beta";
    case "testnet":
      return "testnet";
    case "localnet":
    case "localhost":
      return "localnet";
    default:
      return "devnet";
  }
}

const shutdown = new GracefulShutdown({ shutdownTimeoutMs, logger });
shutdown.register("database", () => closeDatabase());
shutdown.register("tracing", () => tracing.shutdown());

const coinflow = loadCoinflow();
const shopify = loadShopify();
const kyc = loadKyc();
const pix = loadPix();

const app = createApp({
  db,
  solana,
  shutdown,
  coinflow,
  shopify,
  ...(kyc ? { kyc } : {}),
  treasury: {
    adminKey: process.env.ZETTAPAY_TREASURY_ADMIN_KEY ?? null,
    ...(process.env.ZETTAPAY_TREASURY_RESERVE_RATIO !== undefined
      ? { reserveRatio: Number(process.env.ZETTAPAY_TREASURY_RESERVE_RATIO) }
      : {}),
  },
  admin: {
    adminKey: process.env.ZETTAPAY_ADMIN_KEY ?? null,
  },
  ...(pix ? { pix } : {}),
});
const attestation = loadAttestation();

const app = createApp({ db, solana, shutdown, coinflow, attestation });
const evm = loadEvm();

const app = createApp({ db, solana, shutdown, coinflow, evm });

const server = app.listen(port, host, () => {
  logger.info("server.listening", { host, port });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

shutdown.install(server);

function loadShopify(): ShopifyAppConfig | null {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  const appUrl = process.env.SHOPIFY_APP_URL;
  if (!apiKey || !apiSecret || !appUrl) return null;
  const scopes = process.env.SHOPIFY_SCOPES ?? "read_orders,write_script_tags";
  return { apiKey, apiSecret, scopes, appUrl };
}

function loadKyc(): KycProviderClient | undefined {
  const appToken = process.env.SUMSUB_APP_TOKEN;
  const secretKey = process.env.SUMSUB_SECRET_KEY;
  const webhookSecret = process.env.SUMSUB_WEBHOOK_SECRET;
  if (!appToken || !secretKey || !webhookSecret) return undefined;
  const baseUrl = process.env.SUMSUB_BASE_URL;
  return createSumsubClient({
    appToken,
    secretKey,
    webhookSecret,
    ...(baseUrl ? { baseUrl } : {}),
  });
function loadEvm(): EvmService | undefined {
  const key = process.env.EVM_PAYER_PRIVATE_KEY?.trim();
  if (!key) return undefined;
  return new EvmService({ payerPrivateKey: key });
}

function loadCoinflow(): CoinflowClient | undefined {
  const apiKey = process.env.COINFLOW_API_KEY;
  if (!apiKey) return undefined;
  const envValue = (process.env.COINFLOW_ENV ?? "sandbox").toLowerCase();
  if (envValue !== "sandbox" && envValue !== "production") {
    logger.error("coinflow.env.invalid", { value: envValue });
    return undefined;
  }
  const baseUrl = process.env.COINFLOW_BASE_URL;
  return new HttpCoinflowClient({
    apiKey,
    environment: envValue as CoinflowEnvironment,
    ...(baseUrl ? { baseUrl } : {}),
  });
}

interface PixServerConfig {
  resolveClient: (provider: PixProvider) => PixClient | undefined;
  availableProviders: readonly PixProvider[];
}

/**
 * Load Pix payout providers from env. Each provider is independently
 * configurable so an operator can ship Bitpreço-only, Transfero-only, or
 * both. Per-provider env keys: `<PROVIDER>_API_KEY`, `<PROVIDER>_ENV`,
 * `<PROVIDER>_BASE_URL`. Shared env: `PIX_ENV` falls through when a provider
 * doesn't override it.
 */
function loadPix(): PixServerConfig | undefined {
  const sharedEnv = (process.env.PIX_ENV ?? "sandbox").toLowerCase();
  const clients = new Map<PixProvider, PixClient>();

  for (const provider of PIX_PROVIDERS) {
    if (!isPixProvider(provider)) continue;
    const upper = provider.toUpperCase();
    const apiKey = process.env[`${upper}_API_KEY`];
    if (!apiKey) continue;
    const providerEnv = (
      process.env[`${upper}_ENV`] ?? sharedEnv
    ).toLowerCase();
    if (providerEnv !== "sandbox" && providerEnv !== "production") {
      logger.error("pix.env.invalid", { provider, value: providerEnv });
      continue;
    }
    const baseUrl = process.env[`${upper}_BASE_URL`];
    clients.set(
      provider,
      createPixClient(provider, {
        apiKey,
        environment: providerEnv as PixEnvironment,
        ...(baseUrl ? { baseUrl } : {}),
      }),
    );
  }

  if (clients.size === 0) return undefined;

  return {
    resolveClient: (provider) => clients.get(provider),
    availableProviders: Array.from(clients.keys()),
  };
function loadAttestation(): AttestationClient | undefined {
  // Bridge support is opt-in: setting BRIDGE_ATTESTATION_ENV mounts /bridge/*.
  // Defaults to off so dev environments without a CCTP setup don't expose
  // an endpoint that always 502s.
  const raw = process.env.BRIDGE_ATTESTATION_ENV;
  if (!raw) return undefined;
  const envValue = raw.toLowerCase();
  if (envValue !== "sandbox" && envValue !== "production") {
    logger.error("bridge.attestation.env.invalid", { value: envValue });
    return undefined;
  }
  const baseUrl = process.env.BRIDGE_ATTESTATION_BASE_URL;
  return new HttpAttestationClient({
    environment: envValue as AttestationEnvironment,
    ...(baseUrl ? { baseUrl } : {}),
  });
}
