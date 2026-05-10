import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import express from "express";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  createWebhookEvent,
  finalizeWebhookEvent,
  getWebhookEventByEventId,
  recordAttempt,
} from "../src/db/webhook_events.js";
import { errorHandler } from "../src/middleware/error.js";
import { webhooksRouter } from "../src/routes/webhooks.js";

function buildApp(db: Db, redispatch?: Parameters<typeof webhooksRouter>[1]) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(webhooksRouter(db, redispatch ?? {}));
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

describe("GET /webhooks/events", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("rejects requests without an API key", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events`);
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("rejects requests with an unknown API key", async () => {
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events`, {
        headers: { "x-zettapay-api-key": "zp_live_unknown" },
      });
      expect(res.status).toBe(401);
    } finally {
      await close();
    }
  });

  it("returns an empty list with webhookUrl=null when merchant has no webhook", async () => {
    const merchant = registerMerchant(db, {
      name: "No Hook",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "no-hook@test.io",
      webhookUrl: null,
    });
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events`, {
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { events: unknown[]; webhookUrl: string | null };
      expect(json.events).toEqual([]);
      expect(json.webhookUrl).toBeNull();
    } finally {
      await close();
    }
  });

  it("returns only events scoped to the merchant's webhook URL", async () => {
    const myUrl = "https://merchant-a.example/hooks";
    const otherUrl = "https://merchant-b.example/hooks";

    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: myUrl,
    });

    createWebhookEvent(db, {
      id: "whe_a",
      eventId: "evt_mine_a",
      url: myUrl,
      payload: { type: "payment.confirmed", amount: 5 },
      maxAttempts: 9,
    });
    createWebhookEvent(db, {
      id: "whe_b",
      eventId: "evt_mine_b",
      url: myUrl,
      payload: { type: "payment.failed" },
      maxAttempts: 9,
    });
    createWebhookEvent(db, {
      id: "whe_c",
      eventId: "evt_other",
      url: otherUrl,
      payload: { type: "payment.confirmed" },
      maxAttempts: 9,
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events`, {
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        events: Array<{ eventId: string; url: string }>;
        webhookUrl: string;
      };
      expect(json.webhookUrl).toBe(myUrl);
      expect(json.events).toHaveLength(2);
      expect(json.events.every((e) => e.url === myUrl)).toBe(true);
      expect(json.events.map((e) => e.eventId).sort()).toEqual([
        "evt_mine_a",
        "evt_mine_b",
      ]);
    } finally {
      await close();
    }
  });

  it("filters by status when provided", async () => {
    const url = "https://merchant.example/hooks";
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: url,
    });

    createWebhookEvent(db, { id: "whe_x", eventId: "evt_x", url, payload: {}, maxAttempts: 1 });
    createWebhookEvent(db, { id: "whe_y", eventId: "evt_y", url, payload: {}, maxAttempts: 1 });
    finalizeWebhookEvent(db, { eventId: "evt_x", status: "sent" });
    finalizeWebhookEvent(db, { eventId: "evt_y", status: "dead", deadLetterReason: "retries_exhausted" });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events?status=dead`, {
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      const json = (await res.json()) as { events: Array<{ eventId: string; status: string }> };
      expect(json.events).toHaveLength(1);
      expect(json.events[0]!.eventId).toBe("evt_y");
      expect(json.events[0]!.status).toBe("dead");
    } finally {
      await close();
    }
  });

  it("rejects an unknown status filter with 400", async () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: "https://merchant.example/hooks",
    });

    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events?status=cooked`, {
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });
});

describe("POST /webhooks/events/:eventId/retry", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("re-dispatches a failed event and finalizes it as sent on success", async () => {
    const url = "https://merchant.example/hooks";
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
      payload: { type: "payment.confirmed", amount: 12 },
      maxAttempts: 1,
    });
    recordAttempt(db, {
      eventId: "evt_z",
      attempt: 1,
      statusCode: 503,
      error: null,
      attemptedAt: "2026-05-09T10:00:00.000Z",
    });
    finalizeWebhookEvent(db, { eventId: "evt_z", status: "failed" });

    const calls: Array<{ eventId?: string; payload: unknown; secret?: string }> = [];

    const app = buildApp(db, {
      redispatch: async (innerDb, options) => {
        calls.push({
          ...(options.eventId ? { eventId: options.eventId } : {}),
          payload: options.payload,
          ...(options.secret ? { secret: options.secret } : {}),
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
          attempts: [{ attempt: 1, status: 200, ok: true, durationMs: 12 }],
        };
      },
    });
    const { baseUrl, close } = await listen(app);

    try {
      const res = await fetch(`${baseUrl}/webhooks/events/evt_z/retry`, {
        method: "POST",
        headers: { "x-zettapay-api-key": merchant.apiKey },
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
      expect(calls[0]!.payload).toEqual({ type: "payment.confirmed", amount: 12 });
      expect(calls[0]!.secret).toBe(merchant.webhookSecret!);

      const refreshed = getWebhookEventByEventId(db, "evt_z")!;
      expect(refreshed.status).toBe("sent");
    } finally {
      await close();
    }
  });

  it("returns 404 when the event belongs to a different merchant", async () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: "https://acme.example/hooks",
    });
    createWebhookEvent(db, {
      id: "whe_other",
      eventId: "evt_other",
      url: "https://other.example/hooks",
      payload: {},
      maxAttempts: 1,
    });
    finalizeWebhookEvent(db, { eventId: "evt_other", status: "failed" });

    const app = buildApp(db, {
      redispatch: async () => {
        throw new Error("redispatch should not run on cross-merchant retry");
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events/evt_other/retry`, {
        method: "POST",
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(404);
    } finally {
      await close();
    }
  });

  it("rejects retry on an event that is already pending", async () => {
    const url = "https://merchant.example/hooks";
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: url,
    });
    createWebhookEvent(db, {
      id: "whe_pending",
      eventId: "evt_pending",
      url,
      payload: {},
      maxAttempts: 9,
    });

    const app = buildApp(db, {
      redispatch: async () => {
        throw new Error("redispatch should not run on pending retry");
      },
    });
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events/evt_pending/retry`, {
        method: "POST",
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(409);
    } finally {
      await close();
    }
  });

  it("returns 400 when merchant has no webhook URL configured", async () => {
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "acme@test.io",
      webhookUrl: null,
    });
    const app = buildApp(db);
    const { baseUrl, close } = await listen(app);
    try {
      const res = await fetch(`${baseUrl}/webhooks/events/evt_x/retry`, {
        method: "POST",
        headers: { "x-zettapay-api-key": merchant.apiKey },
      });
      expect(res.status).toBe(400);
    } finally {
      await close();
    }
  });
});
