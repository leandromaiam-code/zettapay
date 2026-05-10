import { Router } from "express";
import { HttpError } from "../lib/errors.js";
import { optionalString, requireString } from "../lib/validate.js";
import { treasuryAuth } from "../middleware/treasury-auth.js";
import type {
  IncidentService,
  IncidentSeverity,
  IncidentStatus,
} from "../services/incident.js";

const VALID_SEVERITIES = new Set<IncidentSeverity>(["sev1", "sev2", "sev3"]);
const VALID_UPDATE_STATUSES = new Set<IncidentStatus>([
  "investigating",
  "identified",
  "monitoring",
]);

export interface IncidentsRouterDeps {
  incidents: IncidentService;
  /** Reuses the treasury admin key — same blast-radius (mainnet kill switch). */
  adminKey: string | null | undefined;
}

function parseSeverity(body: Record<string, unknown>): IncidentSeverity {
  const raw = requireString(body, "severity", { maxLength: 8 }).toLowerCase();
  if (!VALID_SEVERITIES.has(raw as IncidentSeverity)) {
    throw HttpError.badRequest(
      `Field "severity" must be one of: ${Array.from(VALID_SEVERITIES).join(", ")}`,
    );
  }
  return raw as IncidentSeverity;
}

function parseUpdateStatus(body: Record<string, unknown>): IncidentStatus {
  const raw = requireString(body, "status", { maxLength: 16 }).toLowerCase();
  if (!VALID_UPDATE_STATUSES.has(raw as IncidentStatus)) {
    throw HttpError.badRequest(
      `Field "status" must be one of: ${Array.from(VALID_UPDATE_STATUSES).join(", ")}`,
    );
  }
  return raw as IncidentStatus;
}

function parseAffectedComponents(body: Record<string, unknown>): string[] {
  const raw = body.affectedComponents;
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw HttpError.badRequest("Field \"affectedComponents\" must be an array of strings");
  }
  if (raw.length > 16) {
    throw HttpError.badRequest("Field \"affectedComponents\" must be ≤16 entries");
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      throw HttpError.badRequest("affectedComponents entries must be strings");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > 64) {
      throw HttpError.badRequest("affectedComponents entries must be ≤64 chars");
    }
    out.push(trimmed);
  }
  return Array.from(new Set(out));
}

export function incidentsRouter(deps: IncidentsRouterDeps): Router {
  const router = Router();
  const auth = treasuryAuth({ adminKey: deps.adminKey });

  // Public status page payload — no auth, designed to be scraped by
  // status.zettapay.io / external monitors. Cache for 10s to absorb burst load.
  router.get("/status", (_req, res) => {
    res.setHeader("Cache-Control", "public, max-age=10, s-maxage=10");
    res.json(deps.incidents.publicStatus());
  });

  router.get("/admin/incidents", auth, (req, res, next) => {
    try {
      const includeResolved = req.query.includeResolved === "1"
        || req.query.includeResolved === "true";
      const limitRaw = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw!, 500)) : 50;
      const incidents = includeResolved
        ? deps.incidents.listAll(limit)
        : deps.incidents.listOpen();
      res.json({ incidents });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/incidents", auth, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = requireString(body, "title", { maxLength: 200 });
      const severity = parseSeverity(body);
      const initialMessage = optionalString(body, "initialMessage", { maxLength: 2000 });
      const affectedComponents = parseAffectedComponents(body);
      const killSwitch = body.killSwitch === true;
      const actor = req.treasury?.treasuryActor ?? "incident-admin";
      const incident = deps.incidents.open({
        title,
        severity,
        killSwitch,
        affectedComponents,
        ...(initialMessage ? { initialMessage } : {}),
        actor,
      });
      res.status(201).json({ incident });
    } catch (err) {
      next(err);
    }
  });

  router.get("/admin/incidents/:id", auth, (req, res, next) => {
    try {
      const incident = deps.incidents.get(req.params.id ?? "");
      if (!incident) throw HttpError.notFound(`incident ${req.params.id} not found`);
      res.json({ incident });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/incidents/:id/updates", auth, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const status = parseUpdateStatus(body);
      const message = requireString(body, "message", { maxLength: 2000 });
      const actor = req.treasury?.treasuryActor ?? "incident-admin";
      const killSwitch =
        body.killSwitch === true ? true : body.killSwitch === false ? false : undefined;
      const incident = deps.incidents.postUpdate(
        req.params.id ?? "",
        { status, message, actor },
        killSwitch,
      );
      res.status(201).json({ incident });
    } catch (err) {
      next(err);
    }
  });

  router.post("/admin/incidents/:id/resolve", auth, (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const message = requireString(body, "message", { maxLength: 2000 });
      const actor = req.treasury?.treasuryActor ?? "incident-admin";
      const incident = deps.incidents.resolve(req.params.id ?? "", message, actor);
      res.json({ incident });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
