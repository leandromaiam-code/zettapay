import type { Database as Db } from "better-sqlite3";
import type { Job, Worker, WorkerOptions } from "bullmq";
import type { Logger } from "../lib/logger.js";
import {
  WEBHOOK_QUEUE_NAME,
  type WebhookDeliveryJob,
} from "../lib/webhook-queue.js";
import { dispatchAndPersistWebhook } from "./webhook_dispatcher.js";

export interface WebhookWorkerOptions {
  db: Db;
  redisUrl: string;
  logger?: Logger;
  /** Concurrent jobs processed per worker instance. Default: 8. */
  concurrency?: number;
  /** BullMQ queue prefix override (mirrors the queue's prefix). */
  prefix?: string;
}

export interface WebhookWorkerHandle {
  /** Underlying BullMQ Worker — exposed for tests and ops introspection. */
  readonly worker: Worker<WebhookDeliveryJob>;
  /**
   * Drain inflight jobs and disconnect from Redis. Safe to call from a
   * GracefulShutdown close hook.
   */
  close(): Promise<void>;
}

/**
 * Boots a BullMQ Worker that consumes the webhook-delivery queue and runs each
 * job through `dispatchAndPersistWebhook`. The worker is intentionally
 * isolated from the request handler so a slow merchant endpoint cannot block
 * `/pay` latency: the API enqueues, the worker dispatches.
 *
 * The dispatcher already owns the retry curve (1s → 24h, max 10 attempts) and
 * persists `pending → sent/failed/dead` to `webhook_events`; the worker layer
 * therefore treats each job as a single async invocation and reports
 * `delivered` / `deadLettered` / `failed` back to BullMQ for log fan-out.
 */
export async function startWebhookWorker(
  options: WebhookWorkerOptions,
): Promise<WebhookWorkerHandle> {
  const { Worker: BullWorker } = await import("bullmq");
  const log = options.logger;
  const concurrency = Math.max(1, options.concurrency ?? 8);

  const workerOptions: WorkerOptions = {
    connection: { url: options.redisUrl } as unknown as WorkerOptions["connection"],
    concurrency,
    ...(options.prefix ? { prefix: options.prefix } : {}),
  };

  const worker = new BullWorker<WebhookDeliveryJob>(
    WEBHOOK_QUEUE_NAME,
    async (job: Job<WebhookDeliveryJob>) => {
      const data = job.data;
      log?.debug("webhook_worker.process_start", {
        jobId: job.id,
        eventId: data.eventId,
        url: data.url,
      });

      const result = await dispatchAndPersistWebhook(options.db, {
        eventId: data.eventId,
        url: data.url,
        payload: data.payload,
        secret: data.secret ?? undefined,
        maxAttempts: data.maxAttempts,
        retryDelaysMs: data.retryDelaysMs,
        timeoutMs: data.timeoutMs,
      });

      const outcome = result.delivered
        ? "delivered"
        : result.deadLettered
          ? "dead_lettered"
          : "failed";

      log?.info("webhook_worker.process_done", {
        jobId: job.id,
        eventId: data.eventId,
        outcome,
        attempts: result.attempts.length,
        deadLetterReason: result.deadLetterReason ?? null,
      });

      return {
        eventId: result.eventId,
        delivered: result.delivered,
        deadLettered: result.deadLettered,
        deadLetterReason: result.deadLetterReason ?? null,
        attempts: result.attempts.length,
      };
    },
    workerOptions,
  );

  worker.on("failed", (job, err) => {
    log?.error("webhook_worker.job_failed", {
      jobId: job?.id ?? null,
      eventId: job?.data.eventId ?? null,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  worker.on("error", (err) => {
    log?.error("webhook_worker.worker_error", {
      error: err instanceof Error ? err.message : String(err),
    });
  });

  return {
    worker,
    async close() {
      await worker.close();
    },
  };
}
