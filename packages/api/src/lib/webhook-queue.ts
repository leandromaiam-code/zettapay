import type { JobsOptions, Queue, QueueOptions } from "bullmq";

/**
 * Shape of a single queued webhook delivery. Mirrors the persistence + dispatch
 * options without coupling the queue layer to better-sqlite3.
 */
export interface WebhookDeliveryJob {
  eventId: string;
  url: string;
  payload: unknown;
  secret?: string | null;
  maxAttempts?: number;
  retryDelaysMs?: readonly number[];
  timeoutMs?: number;
}

export const WEBHOOK_QUEUE_NAME = "webhook-deliveries";
export const WEBHOOK_JOB_NAME = "deliver";

/**
 * Default BullMQ job options for webhook deliveries. The dispatcher itself owns
 * the per-attempt retry curve (1s → 24h), so the queue layer only retries on
 * unexpected worker crashes — we keep `attempts: 1` and rely on the dispatcher
 * to surface delivered/failed/dead outcomes.
 *
 * `removeOnComplete` keeps Redis bounded; `removeOnFail` retains a small tail
 * so operators can inspect the most recent crash without unbounded growth.
 */
export const DEFAULT_WEBHOOK_JOB_OPTIONS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { count: 1_000, age: 24 * 60 * 60 },
  removeOnFail: { count: 1_000, age: 7 * 24 * 60 * 60 },
};

export interface CreateWebhookQueueOptions {
  redisUrl: string;
  prefix?: string;
}

/**
 * Lazy-loaded BullMQ Queue instance. The dynamic import keeps `bullmq` (and its
 * transitive ioredis dependency) out of cold-start paths that don't enqueue
 * webhooks (tests, request handlers using inline dispatch).
 */
export async function createWebhookQueue(
  options: CreateWebhookQueueOptions,
): Promise<Queue<WebhookDeliveryJob>> {
  const { Queue: BullQueue } = await import("bullmq");
  const queueOptions: QueueOptions = {
    connection: { url: options.redisUrl } as unknown as QueueOptions["connection"],
    ...(options.prefix ? { prefix: options.prefix } : {}),
  };
  return new BullQueue<WebhookDeliveryJob>(WEBHOOK_QUEUE_NAME, queueOptions);
}

/**
 * Enqueue a webhook delivery. The eventId is reused as the BullMQ jobId, so
 * accidental double-enqueue (e.g. duplicate idempotent request) collapses to a
 * single delivery — matching the dispatcher's eventId idempotency guarantee.
 */
export async function enqueueWebhookDelivery(
  queue: Queue<WebhookDeliveryJob>,
  job: WebhookDeliveryJob,
  override: JobsOptions = {},
): Promise<void> {
  await queue.add(WEBHOOK_JOB_NAME, job, {
    ...DEFAULT_WEBHOOK_JOB_OPTIONS,
    jobId: job.eventId,
    ...override,
  });
}
