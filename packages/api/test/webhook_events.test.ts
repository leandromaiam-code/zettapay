import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  createWebhookEvent,
  finalizeWebhookEvent,
  getWebhookEventByEventId,
  listWebhookEvents,
  recordAttempt,
} from "../src/db/webhook_events.js";
import { dispatchAndPersistWebhook } from "../src/services/webhook_dispatcher.js";

function jsonResponse(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeFakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: vi.fn(async (ms: number) => {
      current += ms;
    }),
  };
}

describe("webhook_events persistence", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("table operations", () => {
    it("inserts a new event in pending state with attempt_count = 0", () => {
      const event = createWebhookEvent(db, {
        id: "whe_1",
        eventId: "evt_1",
        url: "https://merchant.example/hooks",
        payload: { event: "payment.confirmed", amount: 10 },
        maxAttempts: 9,
      });

      expect(event.status).toBe("pending");
      expect(event.attemptCount).toBe(0);
      expect(event.maxAttempts).toBe(9);
      expect(event.lastAttemptAt).toBeNull();
      expect(event.lastStatusCode).toBeNull();
      expect(event.deliveredAt).toBeNull();
      expect(event.payload).toEqual({ event: "payment.confirmed", amount: 10 });
    });

    it("records each attempt with status, error and timestamp", () => {
      createWebhookEvent(db, {
        id: "whe_2",
        eventId: "evt_2",
        url: "https://merchant.example/hooks",
        payload: { event: "x" },
        maxAttempts: 9,
      });

      recordAttempt(db, {
        eventId: "evt_2",
        attempt: 1,
        statusCode: 503,
        error: null,
        attemptedAt: "2026-05-09T10:00:00.000Z",
      });
      recordAttempt(db, {
        eventId: "evt_2",
        attempt: 2,
        statusCode: null,
        error: "fetch failed",
        attemptedAt: "2026-05-09T10:00:01.000Z",
      });

      const event = getWebhookEventByEventId(db, "evt_2")!;
      expect(event.attemptCount).toBe(2);
      expect(event.lastStatusCode).toBeNull();
      expect(event.lastError).toBe("fetch failed");
      expect(event.lastAttemptAt).toBe("2026-05-09T10:00:01.000Z");
    });

    it("finalizes to sent with delivered_at set", () => {
      createWebhookEvent(db, {
        id: "whe_3",
        eventId: "evt_3",
        url: "https://merchant.example/hooks",
        payload: {},
        maxAttempts: 9,
      });
      finalizeWebhookEvent(db, {
        eventId: "evt_3",
        status: "sent",
        deliveredAt: "2026-05-09T10:00:02.000Z",
      });

      const event = getWebhookEventByEventId(db, "evt_3")!;
      expect(event.status).toBe("sent");
      expect(event.deliveredAt).toBe("2026-05-09T10:00:02.000Z");
    });

    it("finalizes to dead with dead_letter_reason recorded", () => {
      createWebhookEvent(db, {
        id: "whe_4",
        eventId: "evt_4",
        url: "https://merchant.example/hooks",
        payload: {},
        maxAttempts: 9,
      });
      finalizeWebhookEvent(db, {
        eventId: "evt_4",
        status: "dead",
        deadLetterReason: "non_retryable_status",
      });

      const event = getWebhookEventByEventId(db, "evt_4")!;
      expect(event.status).toBe("dead");
      expect(event.deadLetterReason).toBe("non_retryable_status");
      expect(event.deliveredAt).toBeNull();
    });

    it("rejects status values outside the canonical set", () => {
      expect(() =>
        db
          .prepare(
            "INSERT INTO webhook_events (id, event_id, url, payload_json, status, max_attempts) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("whe_x", "evt_x", "https://example.com", "{}", "weird", 9),
      ).toThrow(/CHECK constraint/i);
    });

    it("enforces unique event_id", () => {
      createWebhookEvent(db, {
        id: "whe_5",
        eventId: "evt_dup",
        url: "https://merchant.example/hooks",
        payload: {},
        maxAttempts: 9,
      });
      expect(() =>
        createWebhookEvent(db, {
          id: "whe_6",
          eventId: "evt_dup",
          url: "https://merchant.example/hooks",
          payload: {},
          maxAttempts: 9,
        }),
      ).toThrow(/UNIQUE constraint/i);
    });

    it("lists by status", () => {
      createWebhookEvent(db, {
        id: "whe_a",
        eventId: "evt_a",
        url: "u",
        payload: {},
        maxAttempts: 9,
      });
      createWebhookEvent(db, {
        id: "whe_b",
        eventId: "evt_b",
        url: "u",
        payload: {},
        maxAttempts: 9,
      });
      finalizeWebhookEvent(db, { eventId: "evt_a", status: "sent" });

      const sent = listWebhookEvents(db, { status: "sent" });
      const pending = listWebhookEvents(db, { status: "pending" });
      expect(sent.map((e) => e.eventId)).toEqual(["evt_a"]);
      expect(pending.map((e) => e.eventId)).toEqual(["evt_b"]);
    });
  });

  describe("dispatchAndPersistWebhook", () => {
    it("upserts pending row before first attempt and marks sent on 2xx", async () => {
      const clock = makeFakeClock();
      const fetchMock = vi.fn(async () => jsonResponse(200));

      const result = await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: { event: "payment.confirmed" },
        eventId: "evt_persist_ok",
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });

      expect(result.delivered).toBe(true);
      const stored = getWebhookEventByEventId(db, "evt_persist_ok")!;
      expect(stored.status).toBe("sent");
      expect(stored.attemptCount).toBe(1);
      expect(stored.lastStatusCode).toBe(200);
      expect(stored.lastError).toBeNull();
      expect(stored.lastAttemptAt).not.toBeNull();
      expect(stored.deliveredAt).not.toBeNull();
    });

    it("persists every attempt and finalizes as dead after retries exhausted", async () => {
      const clock = makeFakeClock();
      const fetchMock = vi.fn(async () => jsonResponse(503));

      const result = await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: { event: "payment.confirmed" },
        eventId: "evt_persist_dead",
        retryDelaysMs: [10, 20],
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });

      expect(result.delivered).toBe(false);
      expect(result.deadLettered).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(3);

      const stored = getWebhookEventByEventId(db, "evt_persist_dead")!;
      expect(stored.status).toBe("dead");
      expect(stored.attemptCount).toBe(3);
      expect(stored.lastStatusCode).toBe(503);
      expect(stored.deadLetterReason).toBe("retries_exhausted");
      expect(stored.deliveredAt).toBeNull();
    });

    it("marks dead with non_retryable_status reason on 4xx", async () => {
      const clock = makeFakeClock();
      const fetchMock = vi.fn(async () => jsonResponse(404));

      await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: {},
        eventId: "evt_persist_404",
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });

      const stored = getWebhookEventByEventId(db, "evt_persist_404")!;
      expect(stored.status).toBe("dead");
      expect(stored.deadLetterReason).toBe("non_retryable_status");
      expect(stored.attemptCount).toBe(1);
      expect(stored.lastStatusCode).toBe(404);
    });

    it("captures transport errors in last_error", async () => {
      const clock = makeFakeClock();
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(jsonResponse(200));

      await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: {},
        eventId: "evt_persist_transport",
        retryDelaysMs: [5],
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });

      const stored = getWebhookEventByEventId(db, "evt_persist_transport")!;
      expect(stored.status).toBe("sent");
      expect(stored.attemptCount).toBe(2);
      expect(stored.lastStatusCode).toBe(200);
    });

    it("does not duplicate the row if dispatch is reinvoked with the same eventId", async () => {
      const clock = makeFakeClock();
      const fetchMock = vi.fn(async () => jsonResponse(200));

      await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: {},
        eventId: "evt_persist_replay",
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });
      await dispatchAndPersistWebhook(db, {
        url: "https://merchant.example/hooks",
        payload: {},
        eventId: "evt_persist_replay",
        fetchImpl: fetchMock,
        sleep: clock.sleep,
        now: clock.now,
      });

      const all = listWebhookEvents(db);
      const matches = all.filter((e) => e.eventId === "evt_persist_replay");
      expect(matches).toHaveLength(1);
      expect(matches[0]!.attemptCount).toBe(1);
    });
  });
});
