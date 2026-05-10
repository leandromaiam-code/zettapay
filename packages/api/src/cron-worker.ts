// Tracing boots before Solana RPC clients connect so tick spans are exported.
import { initTracing } from "./lib/tracing.js";
const tracing = initTracing("zettapay-cron-worker");

import { closeDatabase, openDatabase } from "./db/index.js";
import type { Cluster } from "./lib/currencies.js";
import { logger } from "./lib/logger.js";
import { GracefulShutdown } from "./lib/shutdown.js";
import { SolanaService } from "./services/solana.js";
import { startSubscriptionCron } from "./services/subscription_cron.js";
import {
  readSyntheticMonitorConfigFromEnv,
  startSyntheticMonitor,
} from "./services/synthetic_monitor.js";

/**
 * Standalone subscription cron worker. Drains due subscriptions on a fixed
 * interval and signs charges via the protocol payer. Runs in its own
 * container/dyno alongside the HTTP API — same database, no shared event
 * loop with request handlers.
 *
 * Boot order (fail fast):
 *   1. Open the database the API persists subscriptions to.
 *   2. Construct a SolanaService bound to the same cluster as the API.
 *   3. Start the polling loop.
 *   4. Install SIGTERM/SIGINT handlers that drain inflight ticks before exit.
 */
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

async function main(): Promise<void> {
  const dbPath = process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite";
  const intervalMs = Number.parseInt(
    process.env.SUBSCRIPTION_CRON_INTERVAL_MS ?? "60000",
    10,
  );
  const batchSize = Number.parseInt(
    process.env.SUBSCRIPTION_CRON_BATCH_SIZE ?? "50",
    10,
  );
  const shutdownTimeoutMs = Number.parseInt(
    process.env.SHUTDOWN_TIMEOUT_MS ?? "30000",
    10,
  );

  const db = openDatabase(dbPath);
  const solana = new SolanaService({
    rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.devnet.solana.com",
    commitment:
      (process.env.SOLANA_COMMITMENT as
        | "processed"
        | "confirmed"
        | "finalized"
        | undefined) ?? "confirmed",
    cluster: parseClusterEnv(
      process.env.SOLANA_NETWORK ?? process.env.SOLANA_CLUSTER,
    ),
    usdcMintAddress: process.env.SOLANA_USDC_MINT ?? null,
    payerSecretKey:
      process.env.SOLANA_FEE_PAYER_SECRET ??
      process.env.PAYER_SECRET_KEY ??
      null,
  });

  const shutdown = new GracefulShutdown({ shutdownTimeoutMs, logger });
  shutdown.register("database", () => closeDatabase());
  shutdown.register("tracing", () => tracing.shutdown());

  const handle = startSubscriptionCron({
    db,
    solana,
    intervalMs,
    batchSize,
    logger,
  });
  shutdown.register("subscription_cron", () => handle.close());

  const synthetic = readSyntheticMonitorConfigFromEnv();
  if (synthetic.enabled && synthetic.targetUrl) {
    const monitor = startSyntheticMonitor({
      targetUrl: synthetic.targetUrl,
      intervalMs: synthetic.intervalMs,
      timeoutMs: synthetic.timeoutMs,
      latencyThresholdMs: synthetic.latencyThresholdMs,
      alertAfterFailures: synthetic.alertAfterFailures,
      usePost: synthetic.usePost,
      ...(synthetic.postBody ? { postBody: synthetic.postBody } : {}),
      logger,
    });
    shutdown.register("synthetic_monitor", () => monitor.close());
  } else {
    logger.info("synthetic_monitor.disabled", {
      reason: synthetic.targetUrl ? "explicit_disable" : "no_target_url",
    });
  }

  logger.info("cron_worker.started", { intervalMs, batchSize });

  shutdown.install({
    close(callback) {
      callback?.();
    },
  });
}

main().catch((err) => {
  logger.error("cron_worker.crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
