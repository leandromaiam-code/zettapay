import { randomUUID } from "node:crypto";
import type { Database as Db } from "better-sqlite3";
import {
  createWebhookEvent,
  finalizeWebhookEvent,
  getWebhookEventByEventId,
  recordAttempt,
} from "../db/webhook_events.js";
import { newId } from "../lib/id.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_RETRY_DELAYS_MS,
  dispatchWebhook,
  type DispatchWebhookOptions,
  type WebhookDispatchResult,
} from "../webhook.js";

export interface PersistedDispatchOptions
  extends Omit<DispatchWebhookOptions, "eventId" | "onAttempt" | "onStart"> {
  /**
   * Stable webhook event ID. Reused across retries for idempotency on the
   * receiver side and as the persistence row's logical key.
   */
  eventId?: string;
}

/**
 * Dispatches a webhook and persists its lifecycle (`pending` → `sent`/`failed`/`dead`)
 * in the `webhook_events` table. Each HTTP attempt updates `attempt_count`,
 * `last_attempt_at`, `last_status_code` and `last_error` so an operator can see
 * exactly where a delivery is in its retry curve.
 *
 * Persistence runs through observer callbacks: a row is upserted before the
 * first attempt and finalized after the dispatcher resolves. Observer errors
 * are swallowed by the dispatcher itself, so a database hiccup never masks the
 * actual delivery outcome returned to the caller.
 */
export async function dispatchAndPersistWebhook(
  db: Db,
  options: PersistedDispatchOptions,
): Promise<WebhookDispatchResult> {
  const eventId = options.eventId ?? randomUUID();
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const totalAttempts = Math.max(
    1,
    Math.min(retryDelays.length + 1, maxAttempts),
  );

  ensurePendingRow(db, {
    eventId,
    url: options.url,
    payload: options.payload,
    maxAttempts: totalAttempts,
  });

  const result = await dispatchWebhook({
    ...options,
    eventId,
    onStart: () => {
      // Row is upserted synchronously above so it exists even if the process
      // dies before the first attempt completes.
    },
    onAttempt: ({ attempt, attemptedAt }) => {
      recordAttempt(db, {
        eventId,
        attempt: attempt.attempt,
        statusCode: attempt.status,
        error: attempt.error ?? null,
        attemptedAt,
      });
    },
  });

  if (result.delivered) {
    finalizeWebhookEvent(db, {
      eventId,
      status: "sent",
      deliveredAt: new Date().toISOString(),
    });
  } else if (result.deadLettered) {
    finalizeWebhookEvent(db, {
      eventId,
      status: "dead",
      deadLetterReason: result.deadLetterReason ?? "retries_exhausted",
    });
  } else {
    finalizeWebhookEvent(db, { eventId, status: "failed" });
  }

  return result;
}

function ensurePendingRow(
  db: Db,
  input: { eventId: string; url: string; payload: unknown; maxAttempts: number },
): void {
  const existing = getWebhookEventByEventId(db, input.eventId);
  if (existing) return;
  createWebhookEvent(db, {
    id: newId("whe"),
    eventId: input.eventId,
    url: input.url,
    payload: input.payload,
    maxAttempts: input.maxAttempts,
  });
}
