import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, JobsOptions, Queue } from "bullmq";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { insertMerchant } from "../src/db/merchants.js";
import {
  getWebhookEventByEventId,
  listWebhookEvents,
} from "../src/db/webhook_events.js";
import { dispatchAndPersistWebhook } from "../src/services/webhook_dispatcher.js";
import {
  DEFAULT_WEBHOOK_JOB_OPTIONS,
  WEBHOOK_JOB_NAME,
  WEBHOOK_QUEUE_NAME,
  enqueueWebhookDelivery,
  type WebhookDeliveryJob,
} from "../src/lib/webhook-queue.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface AddCall {
  name: string;
  data: WebhookDeliveryJob;
  opts?: JobsOptions;
}

function fakeQueue(): { queue: Queue<WebhookDeliveryJob>; calls: AddCall[] } {
  const calls: AddCall[] = [];
  const queue = {
    async add(name: string, data: WebhookDeliveryJob, opts?: JobsOptions) {
      calls.push({ name, data, opts });
      return { id: opts?.jobId ?? "auto" } as unknown as Job<WebhookDeliveryJob>;
    },
  } as unknown as Queue<WebhookDeliveryJob>;
  return { queue, calls };
}

describe("webhook-queue: enqueueWebhookDelivery", () => {
  it("uses the canonical queue + job names", () => {
    expect(WEBHOOK_QUEUE_NAME).toBe("webhook-deliveries");
    expect(WEBHOOK_JOB_NAME).toBe("deliver");
  });

  it("forwards the eventId as jobId so duplicate enqueues collapse", async () => {
    const { queue, calls } = fakeQueue();
    await enqueueWebhookDelivery(queue, {
      eventId: "evt_123",
      url: "https://merchant.example/hooks",
      payload: { event: "payment.confirmed" },
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.name).toBe("deliver");
    expect(call?.opts?.jobId).toBe("evt_123");
    expect(call?.data.url).toBe("https://merchant.example/hooks");
  });

  it("layers default job options under any caller-supplied overrides", async () => {
    const { queue, calls } = fakeQueue();
    await enqueueWebhookDelivery(
      queue,
      { eventId: "evt_456", url: "https://merchant.example/hooks", payload: {} },
      { delay: 5_000, attempts: 3 },
    );

    const [call] = calls;
    expect(call?.opts?.delay).toBe(5_000);
    expect(call?.opts?.attempts).toBe(3);
    expect(call?.opts?.removeOnComplete).toEqual(
      DEFAULT_WEBHOOK_JOB_OPTIONS.removeOnComplete,
    );
    expect(call?.opts?.removeOnFail).toEqual(
      DEFAULT_WEBHOOK_JOB_OPTIONS.removeOnFail,
    );
  });
});

describe("webhook worker → dispatchAndPersistWebhook contract", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    insertMerchant(db, {
      id: "mer_test",
      name: "Test Merchant",
      walletAddress: "11111111111111111111111111111112",
      email: "test@example.com",
      apiKey: "key_test",
      webhookUrl: "https://merchant.example/hooks",
      webhookSecret: null,
    });
  });

  afterEach(() => {
    closeDatabase();
  });

  it("processes a queued job by persisting pending → sent on 2xx", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));

    const result = await dispatchAndPersistWebhook(db, {
      eventId: "evt_worker_ok",
      url: "https://merchant.example/hooks",
      payload: { event: "payment.confirmed", id: "pay_1" },
      fetchImpl: fetchMock,
    });

    expect(result.delivered).toBe(true);
    expect(result.attempts).toHaveLength(1);

    const persisted = getWebhookEventByEventId(db, "evt_worker_ok");
    expect(persisted?.status).toBe("sent");
    expect(persisted?.attemptCount).toBe(1);
  });

  it("dead-letters non-retryable status codes from a queued job", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(404));

    const result = await dispatchAndPersistWebhook(db, {
      eventId: "evt_worker_404",
      url: "https://merchant.example/hooks",
      payload: { event: "payment.confirmed" },
      fetchImpl: fetchMock,
    });

    expect(result.delivered).toBe(false);
    expect(result.deadLettered).toBe(true);
    expect(result.deadLetterReason).toBe("non_retryable_status");

    const persisted = getWebhookEventByEventId(db, "evt_worker_404");
    expect(persisted?.status).toBe("dead");
    expect(persisted?.deadLetterReason).toBe("non_retryable_status");
  });

  it("keeps each job's webhook_events row isolated by eventId", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200));

    await dispatchAndPersistWebhook(db, {
      eventId: "evt_a",
      url: "https://merchant.example/hooks",
      payload: { id: "a" },
      fetchImpl: fetchMock,
    });
    await dispatchAndPersistWebhook(db, {
      eventId: "evt_b",
      url: "https://merchant.example/hooks",
      payload: { id: "b" },
      fetchImpl: fetchMock,
    });

    const rows = listWebhookEvents(db);
    expect(rows.map((r) => r.eventId).sort()).toEqual(["evt_a", "evt_b"]);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
  });
});
