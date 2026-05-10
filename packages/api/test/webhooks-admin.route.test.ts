import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import express from "express";
import { Keypair } from "@solana/web3.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  createWebhookEvent,
  finalizeWebhookEvent,
  getWebhookEventByEventId,
  recordAttempt,
} from "../src/db/webhook_events.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { errorHandler } from "../src/middleware/error.js";
import { webhooksAdminRouter } from "../src/routes/webhooks-admin.js";

const ADMIN_KEY = "admin-key-z10-5-with-enough-length";

function buildApp(
  db: Db,
  options: Parameters<typeof webhooksAdminRouter>[1] = { adminKey: ADMIN_KEY },
) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(webhooksAdminRouter(db, options));
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function adminHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "x-api-key": ADMIN_KEY,
    "x-admin-actor": "tester",
    "content-type": "application/json",
    ...extra,
  };
}

describe("admin webhook events stream — auth gating", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns 500 (config_error) when admin key is unset", async () => {
    const app = buildApp(db, { adminKey: null });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`, {
        headers: { "x-api-key": ADMIN_KEY },
      });
      expect(res.status).toBe(500);
      const json = (await res.json()) as { error?: { code?: string } };
      expect(json.error?.code).toBe("config_error");
    } finally {
      await close();
    }
  });

  it("returns 500 when admin key is shorter than 24 chars", async () => {
    const app = buildApp(db, { adminKey: "too-short" });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`, {
        headers: { "x-api-key": "too-short" },
      });
      expect(res.status).toBe(500);
    } finally {
      await close();
    }
  });

  it("rejects requests without an admin key (401)", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("rejects requests with the wrong admin key (401)", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`, {
        headers: { "x-api-key": "wrong-key-but-long-enough-to-try" },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("accepts the admin key via Authorization: Bearer", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`, {
        headers: { authorization: `Bearer ${ADMIN_KEY}` },
      });
      expect(res.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("GET /admin/webhooks/events", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("lists events across multiple merchant URLs with total count", async () => {
    createWebhookEvent(db, {
      id: "whe_a",
      eventId: "evt_a",
      url: "https://merchant-a.example/hooks",
      payload: { type: "payment.confirmed" },
      maxAttempts: 9,
    });
    createWebhookEvent(db, {
      id: "whe_b",
      eventId: "evt_b",
      url: "https://merchant-b.example/hooks",
      payload: { type: "payment.failed" },
      maxAttempts: 9,
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events`, {
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        events: Array<{ eventId: string; url: string }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(json.total).toBe(2);
      expect(json.limit).toBe(100);
      expect(json.offset).toBe(0);
      expect(json.events.map((e) => e.eventId).sort()).toEqual([
        "evt_a",
        "evt_b",
      ]);
    } finally {
      await close();
    }
  });

  it("filters by status", async () => {
    createWebhookEvent(db, {
      id: "whe_p",
      eventId: "evt_p",
      url: "https://m.example/h",
      payload: {},
      maxAttempts: 1,
    });
    createWebhookEvent(db, {
      id: "whe_d",
      eventId: "evt_d",
      url: "https://m.example/h",
      payload: {},
      maxAttempts: 1,
    });
    finalizeWebhookEvent(db, {
      eventId: "evt_d",
      status: "dead",
      deadLetterReason: "retries_exhausted",
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events?status=dead`, {
        headers: adminHeaders(),
      });
      const json = (await res.json()) as {
        events: Array<{ eventId: string; status: string }>;
        total: number;
      };
      expect(json.total).toBe(1);
      expect(json.events).toHaveLength(1);
      expect(json.events[0]!.eventId).toBe("evt_d");
    } finally {
      await close();
    }
  });

  it("filters by url", async () => {
    createWebhookEvent(db, {
      id: "whe_a",
      eventId: "evt_a",
      url: "https://m-a.example/h",
      payload: {},
      maxAttempts: 1,
    });
    createWebhookEvent(db, {
      id: "whe_b",
      eventId: "evt_b",
      url: "https://m-b.example/h",
      payload: {},
      maxAttempts: 1,
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(
        `${baseUrl}/admin/webhooks/events?url=${encodeURIComponent("https://m-b.example/h")}`,
        { headers: adminHeaders() },
      );
      const json = (await res.json()) as {
        events: Array<{ eventId: string }>;
        total: number;
      };
      expect(json.total).toBe(1);
      expect(json.events[0]!.eventId).toBe("evt_b");
    } finally {
      await close();
    }
  });

  it("paginates via limit + offset", async () => {
    for (let i = 0; i < 5; i++) {
      createWebhookEvent(db, {
        id: `whe_${i}`,
        eventId: `evt_${i}`,
        url: "https://m.example/h",
        payload: { i },
        maxAttempts: 1,
      });
    }

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const first = (await (
        await fetch(`${baseUrl}/admin/webhooks/events?limit=2&offset=0`, {
          headers: adminHeaders(),
        })
      ).json()) as {
        events: Array<{ eventId: string }>;
        total: number;
        limit: number;
        offset: number;
      };
      expect(first.total).toBe(5);
      expect(first.limit).toBe(2);
      expect(first.events).toHaveLength(2);

      const second = (await (
        await fetch(`${baseUrl}/admin/webhooks/events?limit=2&offset=2`, {
          headers: adminHeaders(),
        })
      ).json()) as { events: Array<{ eventId: string }>; offset: number };
      expect(second.offset).toBe(2);
      expect(second.events).toHaveLength(2);
      const firstIds = new Set(first.events.map((e) => e.eventId));
      const secondIds = new Set(second.events.map((e) => e.eventId));
      for (const id of secondIds) expect(firstIds.has(id)).toBe(false);
    } finally {
      await close();
    }
  });

  it("rejects invalid status with 400", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(
        `${baseUrl}/admin/webhooks/events?status=cooked`,
        { headers: adminHeaders() },
      );
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe("GET /admin/webhooks/events/summary", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns counts grouped by status", async () => {
    const url = "https://m.example/h";
    createWebhookEvent(db, {
      id: "whe_1",
      eventId: "evt_1",
      url,
      payload: {},
      maxAttempts: 1,
    });
    createWebhookEvent(db, {
      id: "whe_2",
      eventId: "evt_2",
      url,
      payload: {},
      maxAttempts: 1,
    });
    finalizeWebhookEvent(db, { eventId: "evt_1", status: "sent" });
    finalizeWebhookEvent(db, {
      eventId: "evt_2",
      status: "dead",
      deadLetterReason: "retries_exhausted",
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events/summary`, {
        headers: adminHeaders(),
      });
      const json = (await res.json()) as {
        counts: {
          pending: number;
          sent: number;
          failed: number;
          dead: number;
          total: number;
        };
      };
      expect(json.counts.sent).toBe(1);
      expect(json.counts.dead).toBe(1);
      expect(json.counts.pending).toBe(0);
      expect(json.counts.failed).toBe(0);
      expect(json.counts.total).toBe(2);
    } finally {
      await close();
    }
  });
});

describe("GET /admin/webhooks/events/:eventId", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns 404 for unknown ids", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events/evt_missing`, {
        headers: adminHeaders(),
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("returns full event detail including attempts", async () => {
    createWebhookEvent(db, {
      id: "whe_x",
      eventId: "evt_x",
      url: "https://m.example/h",
      payload: { type: "payment.confirmed", amount: 7 },
      maxAttempts: 3,
    });
    recordAttempt(db, {
      eventId: "evt_x",
      attempt: 1,
      statusCode: 503,
      error: null,
      attemptedAt: "2026-05-09T10:00:00.000Z",
    });
    finalizeWebhookEvent(db, { eventId: "evt_x", status: "failed" });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events/evt_x`, {
        headers: adminHeaders(),
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        event: {
          eventId: string;
          status: string;
          attemptCount: number;
          lastStatusCode: number | null;
          payload: unknown;
        };
      };
      expect(json.event.eventId).toBe("evt_x");
      expect(json.event.status).toBe("failed");
      expect(json.event.attemptCount).toBe(1);
      expect(json.event.lastStatusCode).toBe(503);
      expect(json.event.payload).toEqual({ type: "payment.confirmed", amount: 7 });
    } finally {
      await close();
    }
  });
});

describe("POST /admin/webhooks/events/:eventId/retry", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("redispatches a failed event, finalizes as sent, and audits the action", async () => {
    const url = "https://m.example/h";
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: url,
    });
    createWebhookEvent(db, {
      id: "whe_z",
      eventId: "evt_z",
      url,
      payload: { type: "payment.failed" },
      maxAttempts: 1,
    });
    finalizeWebhookEvent(db, { eventId: "evt_z", status: "failed" });

    const calls: Array<{ eventId?: string; secret?: string; payload: unknown }> = [];
    const app = buildApp(db, {
      adminKey: ADMIN_KEY,
      redispatch: async (innerDb, options) => {
        calls.push({
          ...(options.eventId ? { eventId: options.eventId } : {}),
          ...(options.secret ? { secret: options.secret } : {}),
          payload: options.payload,
        });
        finalizeWebhookEvent(innerDb, {
          eventId: options.eventId!,
          status: "sent",
          deliveredAt: new Date().toISOString(),
        });
        return {
          eventId: options.eventId!,
          delivered: true,
          deadLettered: false,
          attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 8 }],
        };
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events/evt_z/retry`, {
        method: "POST",
        headers: adminHeaders(),
      });
      expect(res.status).toBe(202);
      const json = (await res.json()) as {
        delivered: boolean;
        event: { status: string; eventId: string };
      };
      expect(json.delivered).toBe(true);
      expect(json.event.eventId).toBe("evt_z");
      expect(json.event.status).toBe("sent");
      expect(calls).toHaveLength(1);
      expect(calls[0]!.eventId).toBe("evt_z");
      expect(calls[0]!.secret).toBe(merchant.webhookSecret!);

      const refreshed = getWebhookEventByEventId(db, "evt_z")!;
      expect(refreshed.status).toBe("sent");

      const audits = listAuditEntries(db, { event: "webhook.retry" });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.actor).toBe("tester");
      expect(audits[0]!.entityId).toBe("evt_z");
    } finally {
      await close();
    }
  });

  it("returns 409 when the event is still pending", async () => {
    const url = "https://m.example/h";
    createWebhookEvent(db, {
      id: "whe_p",
      eventId: "evt_p",
      url,
      payload: {},
      maxAttempts: 9,
    });

    const app = buildApp(db, {
      adminKey: ADMIN_KEY,
      redispatch: async () => {
        throw new Error("redispatch should not run on pending retry");
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/admin/webhooks/events/evt_p/retry`, {
        method: "POST",
        headers: adminHeaders(),
      });
      expect(res.status).toBe(409);
    } finally {
      await close();
    }
  });

  it("returns 404 when the event does not exist", async () => {
    const app = buildApp(db, {
      adminKey: ADMIN_KEY,
      redispatch: async () => {
        throw new Error("redispatch should not run on missing event");
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(
        `${baseUrl}/admin/webhooks/events/evt_missing/retry`,
        { method: "POST", headers: adminHeaders() },
      );
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});

describe("POST /admin/webhooks/events/:eventId/replay", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("creates a new event with a fresh id and the same payload", async () => {
    const url = "https://m.example/h";
    registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: url,
    });

    createWebhookEvent(db, {
      id: "whe_src",
      eventId: "evt_src",
      url,
      payload: { type: "payment.confirmed", amount: 42 },
      maxAttempts: 1,
    });
    finalizeWebhookEvent(db, {
      eventId: "evt_src",
      status: "dead",
      deadLetterReason: "retries_exhausted",
    });

    const calls: Array<{ eventId?: string; payload: unknown; url: string }> = [];
    const app = buildApp(db, {
      adminKey: ADMIN_KEY,
      redispatch: async (innerDb, options) => {
        calls.push({
          ...(options.eventId ? { eventId: options.eventId } : {}),
          payload: options.payload,
          url: options.url,
        });
        // Mirror dispatchAndPersistWebhook: ensure a row exists for the new
        // event id before finalizing, otherwise the route's lookup returns null.
        if (!getWebhookEventByEventId(innerDb, options.eventId!)) {
          createWebhookEvent(innerDb, {
            id: `whe_${options.eventId}`,
            eventId: options.eventId!,
            url: options.url,
            payload: options.payload,
            maxAttempts: 1,
          });
        }
        finalizeWebhookEvent(innerDb, {
          eventId: options.eventId!,
          status: "sent",
          deliveredAt: new Date().toISOString(),
        });
        return {
          eventId: options.eventId!,
          delivered: true,
          deadLettered: false,
          attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 12 }],
        };
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(
        `${baseUrl}/admin/webhooks/events/evt_src/replay`,
        { method: "POST", headers: adminHeaders() },
      );
      expect(res.status).toBe(202);
      const json = (await res.json()) as {
        delivered: boolean;
        event: { eventId: string; payload: unknown };
        source: { eventId: string };
      };
      expect(json.delivered).toBe(true);
      expect(json.source.eventId).toBe("evt_src");
      expect(json.event.eventId).not.toBe("evt_src");
      expect(json.event.eventId.startsWith("evt_replay_")).toBe(true);
      expect(json.event.payload).toEqual({
        type: "payment.confirmed",
        amount: 42,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toEqual({
        type: "payment.confirmed",
        amount: 42,
      });

      const original = getWebhookEventByEventId(db, "evt_src")!;
      expect(original.status).toBe("dead");

      const audits = listAuditEntries(db, { event: "webhook.replay" });
      expect(audits).toHaveLength(1);
      expect(audits[0]!.entityId).toBe(json.event.eventId);
    } finally {
      await close();
    }
  });

  it("returns 404 when source event does not exist", async () => {
    const app = buildApp(db, {
      adminKey: ADMIN_KEY,
      redispatch: async () => {
        throw new Error("redispatch should not run on missing source");
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(
        `${baseUrl}/admin/webhooks/events/evt_nope/replay`,
        { method: "POST", headers: adminHeaders() },
      );
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });
});
