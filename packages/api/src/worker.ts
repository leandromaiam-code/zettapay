import { closeDatabase, openDatabase } from "./db/index.js";
import { logger } from "./lib/logger.js";
import { GracefulShutdown } from "./lib/shutdown.js";
import { startWebhookWorker } from "./services/webhook_worker.js";

/**
 * Standalone webhook worker process. Runs in its own container/dyno alongside
 * the HTTP API: same database, same Redis, zero shared event loop with the
 * request handler.
 *
 * Boot order (fail fast):
 *   1. REDIS_URL is required — without Redis there is no queue to drain.
 *   2. Open the database the dispatcher persists `webhook_events` to.
 *   3. Start the BullMQ Worker.
 *   4. Install SIGTERM/SIGINT handlers that drain inflight jobs before exit.
 */
async function main(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    logger.error("worker.boot_failed", {
      reason: "REDIS_URL not configured",
    });
    process.exit(1);
  }

  const dbPath = process.env.ZETTAPAY_DB_PATH ?? "./data/zettapay.sqlite";
  const concurrency = Number.parseInt(
    process.env.WEBHOOK_WORKER_CONCURRENCY ?? "8",
    10,
  );
  const shutdownTimeoutMs = Number.parseInt(
    process.env.SHUTDOWN_TIMEOUT_MS ?? "30000",
    10,
  );
  const prefix = process.env.WEBHOOK_QUEUE_PREFIX;

  const db = openDatabase(dbPath);
  const shutdown = new GracefulShutdown({ shutdownTimeoutMs, logger });
  shutdown.register("database", () => closeDatabase());

  const handle = await startWebhookWorker({
    db,
    redisUrl,
    logger,
    concurrency,
    ...(prefix ? { prefix } : {}),
  });
  shutdown.register("webhook_worker", () => handle.close());

  logger.info("worker.started", {
    queue: "webhook-deliveries",
    concurrency,
  });

  // The worker has no HTTP server, but GracefulShutdown.install requires a
  // `close`-able. Fake one that resolves immediately so SIGTERM still triggers
  // the drain → close-hook flow.
  shutdown.install({
    close(callback) {
      callback?.();
    },
  });
}

main().catch((err) => {
  logger.error("worker.crashed", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
