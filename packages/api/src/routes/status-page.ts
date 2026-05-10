import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { z } from "zod";
import { appendAudit } from "../db/audit_journal.js";
import {
  COMPONENT_STATUSES,
  INCIDENT_IMPACTS,
  INCIDENT_STATUSES,
  type ComponentStatus,
  type IncidentImpact,
  type IncidentLifecycle,
  appendStatusIncidentUpdate,
  createStatusComponent,
  createStatusIncident,
  ensureStatusPageSchema,
  getStatusComponentById,
  getStatusIncidentById,
  listStatusComponents,
  listStatusIncidents,
  patchStatusIncident,
  updateStatusComponent,
} from "../db/status_page.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { adminAuth } from "../middleware/admin-auth.js";
import {
  buildRssFeed,
  buildStatusSummary,
  hydrateIncident,
} from "../services/status_page.js";

export interface StatusPageRouterOptions {
  /** Shared admin key (>=24 chars). Without it, admin write endpoints
   * hard-fail with config_error — public read endpoints stay live. */
  adminKey: string | null | undefined;
  /** Public site origin used when rendering the RSS feed. Defaults to the
   * STATUS_PAGE_SITE_URL env var, then a safe fallback. */
  siteUrl?: string;
  /** Channel title for the RSS feed. */
  feedTitle?: string;
  /** Channel description for the RSS feed. */
  feedDescription?: string;
}

const componentStatusSchema = z.enum([
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
]);

const incidentStatusSchema = z.enum([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);

const incidentImpactSchema = z.enum(["none", "minor", "major", "critical"]);

const createComponentSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  status: componentStatusSchema.optional(),
});

const updateComponentSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).nullable().optional(),
  position: z.number().int().min(0).max(10_000).optional(),
  status: componentStatusSchema.optional(),
});

const createIncidentSchema = z.object({
  title: z.string().min(1).max(280),
  status: incidentStatusSchema,
  impact: incidentImpactSchema,
  body: z.string().min(1).max(8_000),
  componentIds: z.array(z.string().min(1).max(80)).max(32).optional(),
  startedAt: z.string().datetime().optional(),
});

const incidentUpdateSchema = z.object({
  status: incidentStatusSchema,
  body: z.string().min(1).max(8_000),
});

const patchIncidentSchema = z.object({
  title: z.string().min(1).max(280).optional(),
  impact: incidentImpactSchema.optional(),
});

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function badRequestFromZod(err: z.ZodError): HttpError {
  return HttpError.badRequest("invalid request body", err.flatten());
}

/**
 * Public + admin status page (Z18.4 — Statuspage clone).
 *
 *  PUBLIC
 *   - GET /status                       — JSON snapshot (overall + components + active incidents)
 *   - GET /status/incidents             — paginated incident history
 *   - GET /status/incidents/:id         — single incident with full timeline
 *   - GET /status/feed.rss              — RSS 2.0 feed of recent updates
 *
 *  ADMIN  (gated by ZETTAPAY_ADMIN_KEY — same key/middleware as Z10.5)
 *   - POST  /admin/status/components
 *   - PATCH /admin/status/components/:id
 *   - POST  /admin/status/incidents               (creates incident + first update)
 *   - POST  /admin/status/incidents/:id/updates   (appends update, transitions status)
 *   - PATCH /admin/status/incidents/:id           (title / impact metadata)
 *
 * Rationale (Premissa #32 — public status page is a trust signal). All admin
 * mutations land in the audit journal so we can reconstruct who changed what
 * during postmortems.
 */
export function statusPageRouter(
  db: Db,
  options: StatusPageRouterOptions,
): Router {
  ensureStatusPageSchema(db);
  const router = Router();
  const auth = adminAuth({ adminKey: options.adminKey });
  const siteUrl =
    options.siteUrl ??
    process.env.STATUS_PAGE_SITE_URL ??
    "https://status.zettapay.io";
  const feedTitle = options.feedTitle ?? "ZettaPay status";
  const feedDescription =
    options.feedDescription ??
    "Live incident updates and historical reliability for the ZettaPay platform.";

  router.get(
    "/status",
    asyncHandler((_req, res) => {
      const summary = buildStatusSummary(db);
      res.setHeader("Cache-Control", "public, max-age=15, s-maxage=15");
      res.json(summary);
    }),
  );

  router.get(
    "/status/incidents",
    asyncHandler((req, res) => {
      const limit = parseIntInRange(req.query.limit, 1, 100, 25);
      const offset = parseIntInRange(req.query.offset, 0, 10_000, 0);
      const incidents = listStatusIncidents(db, { limit, offset });
      res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
      res.json({
        limit,
        offset,
        items: incidents.map((i) => hydrateIncident(db, i)),
      });
    }),
  );

  router.get(
    "/status/incidents/:id",
    asyncHandler((req, res, next) => {
      const id = req.params.id?.trim();
      if (!id) return next(HttpError.badRequest("incident id required"));
      const incident = getStatusIncidentById(db, id);
      if (!incident) return next(HttpError.notFound("incident not found"));
      res.setHeader("Cache-Control", "public, max-age=15, s-maxage=15");
      res.json(hydrateIncident(db, incident));
    }),
  );

  router.get(
    "/status/feed.rss",
    asyncHandler((_req, res) => {
      const xml = buildRssFeed(db, {
        siteUrl,
        title: feedTitle,
        description: feedDescription,
      });
      res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
      res.status(200).send(xml);
    }),
  );

  router.post(
    "/admin/status/components",
    auth,
    asyncHandler((req, res, next) => {
      const parsed = createComponentSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      try {
        const created = createStatusComponent(db, {
          id: newId("cmp"),
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          position: parsed.data.position ?? 0,
          status: parsed.data.status ?? "operational",
        });
        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "status_component.created",
          entityType: "status_component",
          entityId: created.id,
          payload: { name: created.name, status: created.status },
        });
        res.status(201).json(created);
      } catch (err) {
        if (
          err instanceof Error &&
          /UNIQUE constraint failed: status_components\.name/.test(err.message)
        ) {
          return next(
            HttpError.conflict(`component name already exists: ${parsed.data.name}`),
          );
        }
        throw err;
      }
    }),
  );

  router.patch(
    "/admin/status/components/:id",
    auth,
    asyncHandler((req, res, next) => {
      const id = req.params.id?.trim();
      if (!id) return next(HttpError.badRequest("component id required"));
      const parsed = updateComponentSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const before = getStatusComponentById(db, id);
      if (!before) return next(HttpError.notFound("component not found"));
      const updated = updateStatusComponent(db, id, {
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.position !== undefined
          ? { position: parsed.data.position }
          : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      });
      if (!updated) return next(HttpError.notFound("component not found"));
      const statusChanged: ComponentStatus | null =
        parsed.data.status !== undefined && parsed.data.status !== before.status
          ? parsed.data.status
          : null;
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "status_component.updated",
        entityType: "status_component",
        entityId: id,
        payload: {
          before: { status: before.status, name: before.name },
          after: { status: updated.status, name: updated.name },
          statusTransition: statusChanged,
        },
      });
      res.json(updated);
    }),
  );

  router.post(
    "/admin/status/incidents",
    auth,
    asyncHandler((req, res, next) => {
      const parsed = createIncidentSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const componentIds = parsed.data.componentIds ?? [];
      for (const cid of componentIds) {
        if (!getStatusComponentById(db, cid)) {
          return next(HttpError.badRequest(`unknown component: ${cid}`));
        }
      }
      const incident = createStatusIncident(db, {
        id: newId("inc"),
        title: parsed.data.title,
        status: parsed.data.status,
        impact: parsed.data.impact,
        ...(parsed.data.startedAt ? { startedAt: parsed.data.startedAt } : {}),
        componentIds,
      });
      const update = appendStatusIncidentUpdate(db, {
        id: newId("upd"),
        incidentId: incident.id,
        status: parsed.data.status,
        body: parsed.data.body,
      });
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "status_incident.created",
        entityType: "status_incident",
        entityId: incident.id,
        payload: {
          title: incident.title,
          impact: incident.impact,
          status: incident.status,
          componentIds,
          firstUpdateId: update.id,
        },
      });
      res.status(201).json({
        ...hydrateIncident(db, getStatusIncidentById(db, incident.id)!),
      });
    }),
  );

  router.post(
    "/admin/status/incidents/:id/updates",
    auth,
    asyncHandler((req, res, next) => {
      const id = req.params.id?.trim();
      if (!id) return next(HttpError.badRequest("incident id required"));
      const parsed = incidentUpdateSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const before = getStatusIncidentById(db, id);
      if (!before) return next(HttpError.notFound("incident not found"));
      const update = appendStatusIncidentUpdate(db, {
        id: newId("upd"),
        incidentId: id,
        status: parsed.data.status,
        body: parsed.data.body,
      });
      const after = getStatusIncidentById(db, id)!;
      const statusChanged: IncidentLifecycle | null =
        before.status !== after.status ? after.status : null;
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "status_incident.update_appended",
        entityType: "status_incident",
        entityId: id,
        payload: {
          updateId: update.id,
          previousStatus: before.status,
          newStatus: after.status,
          statusTransition: statusChanged,
          resolved: after.status === "resolved",
        },
      });
      res.status(201).json({
        update,
        incident: hydrateIncident(db, after),
      });
    }),
  );

  router.patch(
    "/admin/status/incidents/:id",
    auth,
    asyncHandler((req, res, next) => {
      const id = req.params.id?.trim();
      if (!id) return next(HttpError.badRequest("incident id required"));
      const parsed = patchIncidentSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const before = getStatusIncidentById(db, id);
      if (!before) return next(HttpError.notFound("incident not found"));
      const after = patchStatusIncident(db, id, {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.impact !== undefined ? { impact: parsed.data.impact } : {}),
      });
      if (!after) return next(HttpError.notFound("incident not found"));
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "status_incident.patched",
        entityType: "status_incident",
        entityId: id,
        payload: {
          before: { title: before.title, impact: before.impact },
          after: { title: after.title, impact: after.impact },
        },
      });
      res.json(hydrateIncident(db, after));
    }),
  );

  return router;
}

function parseIntInRange(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// Re-exported so the admin dashboard / SDK can pull the canonical enums
// from a single source instead of hard-coding them.
export const STATUS_ENUMS = {
  componentStatuses: Array.from(COMPONENT_STATUSES),
  incidentStatuses: Array.from(INCIDENT_STATUSES),
  incidentImpacts: Array.from(INCIDENT_IMPACTS),
} as const;

export type {
  ComponentStatus,
  IncidentImpact,
  IncidentLifecycle,
};
