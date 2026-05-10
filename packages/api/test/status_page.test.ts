import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import express from "express";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  appendStatusIncidentUpdate,
  createStatusComponent,
  createStatusIncident,
  ensureStatusPageSchema,
  getStatusIncidentById,
  listIncidentUpdates,
  listStatusComponents,
  listStatusIncidents,
} from "../src/db/status_page.js";
import {
  buildRssFeed,
  buildStatusSummary,
  computeOverallStatus,
} from "../src/services/status_page.js";
import { errorHandler } from "../src/middleware/error.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { statusPageRouter } from "../src/routes/status-page.js";

const ADMIN_KEY = "status-admin-key-with-enough-length";

function buildApp(db: Db, adminKey: string | null = ADMIN_KEY) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(
    statusPageRouter(db, {
      adminKey,
      siteUrl: "https://status.zettapay.io",
      feedTitle: "ZettaPay status",
      feedDescription: "Live incident updates.",
    }),
  );
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

describe("status page · DB layer", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    ensureStatusPageSchema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("creates components and surfaces them ordered by position", () => {
    createStatusComponent(db, { id: "cmp_a", name: "API", position: 1 });
    createStatusComponent(db, { id: "cmp_b", name: "Webhooks", position: 0 });
    const list = listStatusComponents(db);
    expect(list.map((c) => c.name)).toEqual(["Webhooks", "API"]);
    expect(list.every((c) => c.status === "operational")).toBe(true);
  });

  it("rejects duplicate component names at the SQL layer", () => {
    createStatusComponent(db, { id: "cmp_x", name: "API" });
    expect(() =>
      createStatusComponent(db, { id: "cmp_y", name: "API" }),
    ).toThrow(/UNIQUE constraint failed: status_components\.name/);
  });

  it("appending a resolved update closes the incident and stamps resolved_at", () => {
    createStatusComponent(db, { id: "cmp_a", name: "API" });
    createStatusIncident(db, {
      id: "inc_1",
      title: "RPC degraded",
      status: "investigating",
      impact: "minor",
      componentIds: ["cmp_a"],
    });
    appendStatusIncidentUpdate(db, {
      id: "upd_1",
      incidentId: "inc_1",
      status: "monitoring",
      body: "RPC partner restored",
    });
    const monitoring = getStatusIncidentById(db, "inc_1")!;
    expect(monitoring.status).toBe("monitoring");
    expect(monitoring.resolvedAt).toBeNull();

    appendStatusIncidentUpdate(db, {
      id: "upd_2",
      incidentId: "inc_1",
      status: "resolved",
      body: "Issue resolved.",
    });
    const resolved = getStatusIncidentById(db, "inc_1")!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).not.toBeNull();

    const updates = listIncidentUpdates(db, "inc_1");
    expect(updates).toHaveLength(2);
    expect(updates[0]!.status).toBe("resolved");
  });

  it("activeOnly filter excludes resolved incidents", () => {
    createStatusComponent(db, { id: "cmp_a", name: "API" });
    createStatusIncident(db, {
      id: "inc_active",
      title: "Active",
      status: "investigating",
      impact: "minor",
      componentIds: ["cmp_a"],
    });
    createStatusIncident(db, {
      id: "inc_resolved",
      title: "Past",
      status: "investigating",
      impact: "minor",
      componentIds: ["cmp_a"],
    });
    appendStatusIncidentUpdate(db, {
      id: "upd_r",
      incidentId: "inc_resolved",
      status: "resolved",
      body: "done",
    });
    const active = listStatusIncidents(db, { activeOnly: true });
    expect(active.map((i) => i.id)).toEqual(["inc_active"]);
    const all = listStatusIncidents(db);
    expect(all.map((i) => i.id).sort()).toEqual(["inc_active", "inc_resolved"]);
  });
});

describe("status page · service layer", () => {
  it("computeOverallStatus picks the worst component", () => {
    expect(computeOverallStatus([])).toBe("no_components_configured");
    expect(
      computeOverallStatus([
        baseComponent("a", "operational"),
        baseComponent("b", "operational"),
      ]),
    ).toBe("all_systems_operational");
    expect(
      computeOverallStatus([
        baseComponent("a", "operational"),
        baseComponent("b", "degraded_performance"),
      ]),
    ).toBe("minor_outage");
    expect(
      computeOverallStatus([
        baseComponent("a", "partial_outage"),
        baseComponent("b", "degraded_performance"),
      ]),
    ).toBe("partial_outage");
    expect(
      computeOverallStatus([
        baseComponent("a", "major_outage"),
        baseComponent("b", "operational"),
      ]),
    ).toBe("major_outage");
  });

  it("buildStatusSummary returns active and recently resolved buckets", () => {
    closeDatabase();
    const db = openDatabase(":memory:");
    try {
      ensureStatusPageSchema(db);
      createStatusComponent(db, { id: "cmp_api", name: "API" });
      createStatusComponent(db, {
        id: "cmp_rpc",
        name: "RPC",
        status: "degraded_performance",
      });
      createStatusIncident(db, {
        id: "inc_1",
        title: "Open",
        status: "investigating",
        impact: "minor",
        componentIds: ["cmp_api"],
      });
      appendStatusIncidentUpdate(db, {
        id: "u1",
        incidentId: "inc_1",
        status: "investigating",
        body: "Looking into it.",
      });
      createStatusIncident(db, {
        id: "inc_2",
        title: "Closed",
        status: "investigating",
        impact: "minor",
        componentIds: ["cmp_rpc"],
      });
      appendStatusIncidentUpdate(db, {
        id: "u2",
        incidentId: "inc_2",
        status: "resolved",
        body: "All good.",
      });

      const summary = buildStatusSummary(db);
      expect(summary.overall).toBe("minor_outage");
      expect(summary.components).toHaveLength(2);
      expect(summary.activeIncidents.map((i) => i.id)).toEqual(["inc_1"]);
      expect(summary.recentlyResolved.map((i) => i.id)).toEqual(["inc_2"]);
      expect(summary.activeIncidents[0]!.componentIds).toEqual(["cmp_api"]);
    } finally {
      closeDatabase();
    }
  });

  it("buildRssFeed produces RSS 2.0 with one item per update and escapes XML", () => {
    closeDatabase();
    const db = openDatabase(":memory:");
    try {
      ensureStatusPageSchema(db);
      createStatusComponent(db, { id: "cmp_api", name: "API" });
      createStatusIncident(db, {
        id: "inc_x",
        title: "RPC <flaky> & slow",
        status: "investigating",
        impact: "major",
        componentIds: ["cmp_api"],
      });
      appendStatusIncidentUpdate(db, {
        id: "u_first",
        incidentId: "inc_x",
        status: "investigating",
        body: "Body with <script>alert(1)</script>",
      });
      appendStatusIncidentUpdate(db, {
        id: "u_second",
        incidentId: "inc_x",
        status: "resolved",
        body: "Resolved & monitored.",
      });

      const xml = buildRssFeed(db, {
        siteUrl: "https://status.zettapay.io",
        title: "ZettaPay status",
        description: "Live updates",
        limit: 50,
      });

      expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
      expect(xml).toContain('<rss version="2.0"');
      expect(xml).toContain("<channel>");
      expect(xml).toContain("<atom:link");
      expect(xml).toContain("status.zettapay.io/status/incidents/inc_x");
      // Escaped — raw < > & must not survive
      expect(xml).toContain("RPC &lt;flaky&gt; &amp; slow");
      expect(xml).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(xml).not.toContain("<script>alert(1)</script>");
      // One <item> per update
      const itemCount = (xml.match(/<item>/g) ?? []).length;
      expect(itemCount).toBe(2);
      // Newest first
      const firstItem = xml.indexOf("u_second") >= 0 ? xml.indexOf("u_second") : -1;
      const secondItem = xml.indexOf("u_first") >= 0 ? xml.indexOf("u_first") : -1;
      expect(firstItem).toBeGreaterThan(0);
      expect(secondItem).toBeGreaterThan(firstItem);
    } finally {
      closeDatabase();
    }
  });
});

describe("status page · HTTP routes", () => {
  let db: Db;
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    server = await listen(buildApp(db));
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("GET /status returns operational baseline when no components are configured", async () => {
    const resp = await fetch(`${server.baseUrl}/status`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as Record<string, unknown>;
    expect(body.overall).toBe("no_components_configured");
    expect(body.components).toEqual([]);
    expect(body.activeIncidents).toEqual([]);
  });

  it("GET /status/feed.rss returns valid XML with channel metadata", async () => {
    const resp = await fetch(`${server.baseUrl}/status/feed.rss`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("content-type")).toContain("application/rss+xml");
    const text = await resp.text();
    expect(text).toContain('<rss version="2.0"');
    expect(text).toContain("<title>ZettaPay status</title>");
    expect(text).toContain("https://status.zettapay.io/status");
  });

  it("admin endpoints reject calls without the admin key", async () => {
    const resp = await fetch(`${server.baseUrl}/admin/status/components`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "API" }),
    });
    expect(resp.status).toBe(401);
  });

  it("end-to-end: create component, create incident, append update, surface in summary", async () => {
    const create = await fetch(`${server.baseUrl}/admin/status/components`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        name: "API",
        description: "Payments API",
        position: 0,
        status: "operational",
      }),
    });
    expect(create.status).toBe(201);
    const component = (await create.json()) as { id: string; name: string };
    expect(component.name).toBe("API");

    const dup = await fetch(`${server.baseUrl}/admin/status/components`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ name: "API" }),
    });
    expect(dup.status).toBe(409);

    const flip = await fetch(
      `${server.baseUrl}/admin/status/components/${component.id}`,
      {
        method: "PATCH",
        headers: adminHeaders(),
        body: JSON.stringify({ status: "degraded_performance" }),
      },
    );
    expect(flip.status).toBe(200);

    const incidentResp = await fetch(`${server.baseUrl}/admin/status/incidents`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        title: "Elevated error rate",
        status: "investigating",
        impact: "major",
        body: "We are investigating elevated 5xx rates on /pay.",
        componentIds: [component.id],
      }),
    });
    expect(incidentResp.status).toBe(201);
    const incident = (await incidentResp.json()) as {
      id: string;
      updates: Array<{ id: string; status: string }>;
    };
    expect(incident.updates).toHaveLength(1);

    const updateResp = await fetch(
      `${server.baseUrl}/admin/status/incidents/${incident.id}/updates`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          status: "resolved",
          body: "Hot-fixed and verified.",
        }),
      },
    );
    expect(updateResp.status).toBe(201);

    const summary = (await (
      await fetch(`${server.baseUrl}/status`)
    ).json()) as Record<string, unknown>;
    // Component status was flipped to degraded — overall should reflect that
    expect(summary.overall).toBe("minor_outage");
    expect(Array.isArray(summary.activeIncidents)).toBe(true);
    expect((summary.activeIncidents as unknown[]).length).toBe(0);
    expect((summary.recentlyResolved as unknown[]).length).toBe(1);

    // Audit trail captures every admin write
    const audits = listAuditEntries(db, { limit: 100 });
    const events = audits.map((a) => a.event);
    expect(events).toContain("status_component.created");
    expect(events).toContain("status_component.updated");
    expect(events).toContain("status_incident.created");
    expect(events).toContain("status_incident.update_appended");
  });

  it("admin endpoints hard-fail with config_error when admin key is missing", async () => {
    await server.close();
    closeDatabase();
    db = openDatabase(":memory:");
    server = await listen(buildApp(db, null));
    const resp = await fetch(`${server.baseUrl}/admin/status/components`, {
      method: "POST",
      headers: { "x-api-key": "anything", "content-type": "application/json" },
      body: JSON.stringify({ name: "API" }),
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("config_error");
  });
});

function baseComponent(
  id: string,
  status:
    | "operational"
    | "degraded_performance"
    | "partial_outage"
    | "major_outage",
) {
  return {
    id,
    name: id,
    description: null,
    position: 0,
    status,
    createdAt: "2026-05-10T00:00:00.000Z",
    updatedAt: "2026-05-10T00:00:00.000Z",
  } as const;
}
