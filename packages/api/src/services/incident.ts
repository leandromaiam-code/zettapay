import type { Database as Db } from "better-sqlite3";
import { appendAudit, listAuditEntries, type AuditJournalEntry } from "../db/audit_journal.js";
import { newId } from "../lib/id.js";
import { HttpError } from "../lib/errors.js";

/**
 * Z22.4 — incident response. Persists open incidents through the append-only
 * audit_journal so the kill-switch state survives restarts and every state
 * transition is forensically reconstructable. The cache is rebuilt from the
 * journal on first read so a cold deploy still respects an active kill switch.
 *
 * Lifecycle: investigating → identified → monitoring → resolved.
 * `killSwitch=true` blocks /pay traffic; `severity=sev1` is reserved for
 * mainnet-impacting outages and is the only severity that may auto-engage the
 * kill switch.
 */

export type IncidentSeverity = "sev1" | "sev2" | "sev3";
export type IncidentStatus =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export interface IncidentUpdate {
  at: string;
  status: IncidentStatus;
  message: string;
  actor: string;
}

export interface Incident {
  id: string;
  title: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  killSwitch: boolean;
  affectedComponents: string[];
  openedAt: string;
  openedBy: string;
  resolvedAt: string | null;
  updates: IncidentUpdate[];
}

export interface OpenIncidentInput {
  title: string;
  severity: IncidentSeverity;
  killSwitch?: boolean;
  affectedComponents?: string[];
  initialMessage?: string;
  actor: string;
}

export interface PostUpdateInput {
  status: IncidentStatus;
  message: string;
  actor: string;
}

const EVENT_OPEN = "incident.opened";
const EVENT_UPDATE = "incident.updated";
const EVENT_RESOLVE = "incident.resolved";
const ENTITY_TYPE = "incident";

interface OpenedPayload {
  title: string;
  severity: IncidentSeverity;
  killSwitch: boolean;
  affectedComponents: string[];
  initialMessage: string | null;
  openedAt: string;
}

interface UpdatePayload {
  status: IncidentStatus;
  message: string;
  at: string;
  killSwitch?: boolean;
}

interface ResolvedPayload {
  message: string;
  at: string;
}

function isOpened(p: unknown): p is OpenedPayload {
  return !!p && typeof p === "object" && typeof (p as OpenedPayload).title === "string";
}

function isUpdate(p: unknown): p is UpdatePayload {
  return !!p && typeof p === "object" && typeof (p as UpdatePayload).status === "string";
}

function isResolved(p: unknown): p is ResolvedPayload {
  return !!p && typeof p === "object" && typeof (p as ResolvedPayload).at === "string";
}

export class IncidentService {
  private cache = new Map<string, Incident>();
  private hydrated = false;

  constructor(private readonly db: Db) {}

  private hydrate(): void {
    if (this.hydrated) return;
    const opens = listAuditEntries(this.db, {
      event: EVENT_OPEN,
      entityType: ENTITY_TYPE,
      limit: 1000,
    });
    for (const entry of opens) {
      this.applyOpen(entry);
    }
    const updates = listAuditEntries(this.db, {
      event: EVENT_UPDATE,
      entityType: ENTITY_TYPE,
      limit: 1000,
    }).reverse();
    for (const entry of updates) {
      this.applyUpdate(entry);
    }
    const resolves = listAuditEntries(this.db, {
      event: EVENT_RESOLVE,
      entityType: ENTITY_TYPE,
      limit: 1000,
    }).reverse();
    for (const entry of resolves) {
      this.applyResolve(entry);
    }
    this.hydrated = true;
  }

  private applyOpen(entry: AuditJournalEntry): void {
    if (!entry.entityId) return;
    const payload = entry.payload;
    if (!isOpened(payload)) return;
    const incident: Incident = {
      id: entry.entityId,
      title: payload.title,
      severity: payload.severity,
      status: "investigating",
      killSwitch: payload.killSwitch,
      affectedComponents: [...payload.affectedComponents],
      openedAt: payload.openedAt,
      openedBy: entry.actor,
      resolvedAt: null,
      updates: payload.initialMessage
        ? [
            {
              at: payload.openedAt,
              status: "investigating",
              message: payload.initialMessage,
              actor: entry.actor,
            },
          ]
        : [],
    };
    this.cache.set(incident.id, incident);
  }

  private applyUpdate(entry: AuditJournalEntry): void {
    if (!entry.entityId) return;
    const incident = this.cache.get(entry.entityId);
    if (!incident) return;
    const payload = entry.payload;
    if (!isUpdate(payload)) return;
    incident.status = payload.status;
    if (payload.killSwitch !== undefined) incident.killSwitch = payload.killSwitch;
    incident.updates.push({
      at: payload.at,
      status: payload.status,
      message: payload.message,
      actor: entry.actor,
    });
  }

  private applyResolve(entry: AuditJournalEntry): void {
    if (!entry.entityId) return;
    const incident = this.cache.get(entry.entityId);
    if (!incident) return;
    const payload = entry.payload;
    if (!isResolved(payload)) return;
    incident.status = "resolved";
    incident.killSwitch = false;
    incident.resolvedAt = payload.at;
    incident.updates.push({
      at: payload.at,
      status: "resolved",
      message: payload.message,
      actor: entry.actor,
    });
  }

  open(input: OpenIncidentInput): Incident {
    this.hydrate();
    const id = newId("inc");
    const openedAt = new Date().toISOString();
    const components = (input.affectedComponents ?? []).map((c) => c.trim()).filter(Boolean);
    const killSwitch = input.killSwitch === true;
    if (killSwitch && input.severity !== "sev1") {
      throw HttpError.badRequest(
        "killSwitch may only be engaged on sev1 incidents",
      );
    }
    const payload: OpenedPayload = {
      title: input.title,
      severity: input.severity,
      killSwitch,
      affectedComponents: components,
      initialMessage: input.initialMessage ?? null,
      openedAt,
    };
    appendAudit(this.db, {
      actor: input.actor,
      event: EVENT_OPEN,
      entityType: ENTITY_TYPE,
      entityId: id,
      reason: input.title,
      payload,
    });
    const incident: Incident = {
      id,
      title: input.title,
      severity: input.severity,
      status: "investigating",
      killSwitch,
      affectedComponents: components,
      openedAt,
      openedBy: input.actor,
      resolvedAt: null,
      updates: input.initialMessage
        ? [
            {
              at: openedAt,
              status: "investigating",
              message: input.initialMessage,
              actor: input.actor,
            },
          ]
        : [],
    };
    this.cache.set(id, incident);
    return this.snapshot(incident);
  }

  postUpdate(id: string, input: PostUpdateInput, killSwitch?: boolean): Incident {
    this.hydrate();
    const incident = this.cache.get(id);
    if (!incident) throw HttpError.notFound(`incident ${id} not found`);
    if (incident.status === "resolved") {
      throw HttpError.conflict(
        "incident already resolved — open a new one for follow-up issues",
      );
    }
    if (input.status === "resolved") {
      throw HttpError.badRequest(
        'use POST /incidents/:id/resolve to close an incident',
      );
    }
    const at = new Date().toISOString();
    const payload: UpdatePayload = {
      status: input.status,
      message: input.message,
      at,
    };
    if (killSwitch !== undefined) {
      if (killSwitch && incident.severity !== "sev1") {
        throw HttpError.badRequest(
          "killSwitch may only be engaged on sev1 incidents",
        );
      }
      payload.killSwitch = killSwitch;
    }
    appendAudit(this.db, {
      actor: input.actor,
      event: EVENT_UPDATE,
      entityType: ENTITY_TYPE,
      entityId: id,
      reason: input.status,
      payload,
    });
    incident.status = input.status;
    if (killSwitch !== undefined) incident.killSwitch = killSwitch;
    incident.updates.push({
      at,
      status: input.status,
      message: input.message,
      actor: input.actor,
    });
    return this.snapshot(incident);
  }

  resolve(id: string, message: string, actor: string): Incident {
    this.hydrate();
    const incident = this.cache.get(id);
    if (!incident) throw HttpError.notFound(`incident ${id} not found`);
    if (incident.status === "resolved") {
      throw HttpError.conflict("incident already resolved");
    }
    const at = new Date().toISOString();
    const payload: ResolvedPayload = { message, at };
    appendAudit(this.db, {
      actor,
      event: EVENT_RESOLVE,
      entityType: ENTITY_TYPE,
      entityId: id,
      reason: "resolved",
      payload,
    });
    incident.status = "resolved";
    incident.killSwitch = false;
    incident.resolvedAt = at;
    incident.updates.push({ at, status: "resolved", message, actor });
    return this.snapshot(incident);
  }

  get(id: string): Incident | null {
    this.hydrate();
    const incident = this.cache.get(id);
    return incident ? this.snapshot(incident) : null;
  }

  listOpen(): Incident[] {
    this.hydrate();
    return Array.from(this.cache.values())
      .filter((i) => i.status !== "resolved")
      .sort((a, b) => a.openedAt.localeCompare(b.openedAt))
      .map((i) => this.snapshot(i));
  }

  listAll(limit = 50): Incident[] {
    this.hydrate();
    return Array.from(this.cache.values())
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map((i) => this.snapshot(i));
  }

  /** Cheap O(open-incidents) hot-path lookup for the /pay guard middleware. */
  isKillSwitchEngaged(): boolean {
    this.hydrate();
    for (const incident of this.cache.values()) {
      if (incident.killSwitch && incident.status !== "resolved") return true;
    }
    return false;
  }

  /** Returns the public status-page payload — open incidents only, no actor PII. */
  publicStatus(): {
    status: "operational" | "degraded" | "major_outage";
    killSwitch: boolean;
    incidents: Array<Omit<Incident, "openedBy" | "updates"> & { latestUpdate: IncidentUpdate | null }>;
    generatedAt: string;
  } {
    this.hydrate();
    const open = this.listOpen();
    const killSwitch = open.some((i) => i.killSwitch);
    const hasSev1 = open.some((i) => i.severity === "sev1");
    const status: "operational" | "degraded" | "major_outage" = killSwitch || hasSev1
      ? "major_outage"
      : open.length > 0
        ? "degraded"
        : "operational";
    return {
      status,
      killSwitch,
      incidents: open.map((i) => ({
        id: i.id,
        title: i.title,
        severity: i.severity,
        status: i.status,
        killSwitch: i.killSwitch,
        affectedComponents: i.affectedComponents,
        openedAt: i.openedAt,
        resolvedAt: i.resolvedAt,
        latestUpdate: i.updates.length > 0 ? i.updates[i.updates.length - 1]! : null,
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  private snapshot(incident: Incident): Incident {
    return {
      ...incident,
      affectedComponents: [...incident.affectedComponents],
      updates: incident.updates.map((u) => ({ ...u })),
    };
  }
}
