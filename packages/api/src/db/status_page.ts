import type { Database as Db } from "better-sqlite3";

export type ComponentStatus =
  | "operational"
  | "degraded_performance"
  | "partial_outage"
  | "major_outage";

export type IncidentLifecycle =
  | "investigating"
  | "identified"
  | "monitoring"
  | "resolved";

export type IncidentImpact = "none" | "minor" | "major" | "critical";

export interface StatusComponentRow {
  id: string;
  name: string;
  description: string | null;
  position: number;
  status: ComponentStatus;
  created_at: string;
  updated_at: string;
}

export interface StatusComponent {
  id: string;
  name: string;
  description: string | null;
  position: number;
  status: ComponentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StatusIncidentRow {
  id: string;
  title: string;
  status: IncidentLifecycle;
  impact: IncidentImpact;
  started_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StatusIncident {
  id: string;
  title: string;
  status: IncidentLifecycle;
  impact: IncidentImpact;
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StatusIncidentUpdateRow {
  id: string;
  incident_id: string;
  status: IncidentLifecycle;
  body: string;
  created_at: string;
}

export interface StatusIncidentUpdate {
  id: string;
  incidentId: string;
  status: IncidentLifecycle;
  body: string;
  createdAt: string;
}

export const COMPONENT_STATUSES: ReadonlySet<ComponentStatus> = new Set([
  "operational",
  "degraded_performance",
  "partial_outage",
  "major_outage",
]);

export const INCIDENT_STATUSES: ReadonlySet<IncidentLifecycle> = new Set([
  "investigating",
  "identified",
  "monitoring",
  "resolved",
]);

export const INCIDENT_IMPACTS: ReadonlySet<IncidentImpact> = new Set([
  "none",
  "minor",
  "major",
  "critical",
]);

/**
 * Status page schema (Z18.4). Mirrors the Statuspage shape: a fixed roster of
 * components (API, Solana RPC, Webhooks, Onramp, ...) and an append-only
 * incident timeline. The public RSS feed and JSON snapshot read straight from
 * these tables — no separate cache. Writes are admin-key gated.
 */
export function ensureStatusPageSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS status_components (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      position    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL CHECK (status IN ('operational','degraded_performance','partial_outage','major_outage')) DEFAULT 'operational',
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS status_components_position_idx
      ON status_components(position);

    CREATE TABLE IF NOT EXISTS status_incidents (
      id          TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      status      TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
      impact      TEXT NOT NULL CHECK (impact IN ('none','minor','major','critical')) DEFAULT 'minor',
      started_at  TEXT NOT NULL,
      resolved_at TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS status_incidents_status_idx
      ON status_incidents(status);
    CREATE INDEX IF NOT EXISTS status_incidents_started_at_idx
      ON status_incidents(started_at);

    CREATE TABLE IF NOT EXISTS status_incident_components (
      incident_id  TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
      component_id TEXT NOT NULL REFERENCES status_components(id) ON DELETE CASCADE,
      PRIMARY KEY (incident_id, component_id)
    );

    CREATE INDEX IF NOT EXISTS status_incident_components_component_idx
      ON status_incident_components(component_id);

    CREATE TABLE IF NOT EXISTS status_incident_updates (
      id           TEXT PRIMARY KEY,
      incident_id  TEXT NOT NULL REFERENCES status_incidents(id) ON DELETE CASCADE,
      status       TEXT NOT NULL CHECK (status IN ('investigating','identified','monitoring','resolved')),
      body         TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS status_incident_updates_incident_idx
      ON status_incident_updates(incident_id, created_at);
    CREATE INDEX IF NOT EXISTS status_incident_updates_created_at_idx
      ON status_incident_updates(created_at);
  `);
}

function toComponent(row: StatusComponentRow): StatusComponent {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    position: row.position,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toIncident(row: StatusIncidentRow): StatusIncident {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    impact: row.impact,
    startedAt: row.started_at,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUpdate(row: StatusIncidentUpdateRow): StatusIncidentUpdate {
  return {
    id: row.id,
    incidentId: row.incident_id,
    status: row.status,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface CreateComponentInput {
  id: string;
  name: string;
  description?: string | null;
  position?: number;
  status?: ComponentStatus;
}

export function createStatusComponent(
  db: Db,
  input: CreateComponentInput,
): StatusComponent {
  ensureStatusPageSchema(db);
  db.prepare<[string, string, string | null, number, ComponentStatus]>(
    `INSERT INTO status_components (id, name, description, position, status)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.name,
    input.description ?? null,
    input.position ?? 0,
    input.status ?? "operational",
  );
  return getStatusComponentById(db, input.id)!;
}

export interface UpdateComponentInput {
  name?: string;
  description?: string | null;
  position?: number;
  status?: ComponentStatus;
}

export function updateStatusComponent(
  db: Db,
  id: string,
  patch: UpdateComponentInput,
): StatusComponent | null {
  const existing = getStatusComponentById(db, id);
  if (!existing) return null;
  const next = {
    name: patch.name ?? existing.name,
    description:
      patch.description === undefined ? existing.description : patch.description,
    position: patch.position ?? existing.position,
    status: patch.status ?? existing.status,
  };
  db.prepare<[string, string | null, number, ComponentStatus, string, string]>(
    `UPDATE status_components
        SET name = ?, description = ?, position = ?, status = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    next.name,
    next.description,
    next.position,
    next.status,
    new Date().toISOString(),
    id,
  );
  return getStatusComponentById(db, id);
}

export function getStatusComponentById(
  db: Db,
  id: string,
): StatusComponent | null {
  const row = db
    .prepare<[string]>(`SELECT * FROM status_components WHERE id = ?`)
    .get(id) as StatusComponentRow | undefined;
  return row ? toComponent(row) : null;
}

export function listStatusComponents(db: Db): StatusComponent[] {
  ensureStatusPageSchema(db);
  const rows = db
    .prepare(`SELECT * FROM status_components ORDER BY position ASC, name ASC`)
    .all() as StatusComponentRow[];
  return rows.map(toComponent);
}

export interface CreateIncidentInput {
  id: string;
  title: string;
  status: IncidentLifecycle;
  impact: IncidentImpact;
  startedAt?: string;
  componentIds: string[];
}

export function createStatusIncident(
  db: Db,
  input: CreateIncidentInput,
): StatusIncident {
  ensureStatusPageSchema(db);
  const startedAt = input.startedAt ?? new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare<[string, string, IncidentLifecycle, IncidentImpact, string]>(
      `INSERT INTO status_incidents (id, title, status, impact, started_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.title, input.status, input.impact, startedAt);
    const link = db.prepare<[string, string]>(
      `INSERT OR IGNORE INTO status_incident_components (incident_id, component_id)
       VALUES (?, ?)`,
    );
    for (const componentId of input.componentIds) {
      link.run(input.id, componentId);
    }
  });
  tx();
  return getStatusIncidentById(db, input.id)!;
}

export interface PatchIncidentInput {
  title?: string;
  impact?: IncidentImpact;
}

export function patchStatusIncident(
  db: Db,
  id: string,
  patch: PatchIncidentInput,
): StatusIncident | null {
  const existing = getStatusIncidentById(db, id);
  if (!existing) return null;
  const next = {
    title: patch.title ?? existing.title,
    impact: patch.impact ?? existing.impact,
  };
  db.prepare<[string, IncidentImpact, string, string]>(
    `UPDATE status_incidents
        SET title = ?, impact = ?, updated_at = ?
      WHERE id = ?`,
  ).run(next.title, next.impact, new Date().toISOString(), id);
  return getStatusIncidentById(db, id);
}

export function getStatusIncidentById(
  db: Db,
  id: string,
): StatusIncident | null {
  const row = db
    .prepare<[string]>(`SELECT * FROM status_incidents WHERE id = ?`)
    .get(id) as StatusIncidentRow | undefined;
  return row ? toIncident(row) : null;
}

export function listStatusIncidents(
  db: Db,
  options: { limit?: number; offset?: number; activeOnly?: boolean } = {},
): StatusIncident[] {
  ensureStatusPageSchema(db);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const rows = options.activeOnly
    ? (db
        .prepare<[number, number]>(
          `SELECT * FROM status_incidents
            WHERE status != 'resolved'
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as StatusIncidentRow[])
    : (db
        .prepare<[number, number]>(
          `SELECT * FROM status_incidents
            ORDER BY started_at DESC
            LIMIT ? OFFSET ?`,
        )
        .all(limit, offset) as StatusIncidentRow[]);
  return rows.map(toIncident);
}

export function listIncidentComponentIds(db: Db, incidentId: string): string[] {
  const rows = db
    .prepare<[string]>(
      `SELECT component_id FROM status_incident_components WHERE incident_id = ?`,
    )
    .all(incidentId) as Array<{ component_id: string }>;
  return rows.map((r) => r.component_id);
}

export interface AppendIncidentUpdateInput {
  id: string;
  incidentId: string;
  status: IncidentLifecycle;
  body: string;
  createdAt?: string;
}

export function appendStatusIncidentUpdate(
  db: Db,
  input: AppendIncidentUpdateInput,
): StatusIncidentUpdate {
  ensureStatusPageSchema(db);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare<[string, string, IncidentLifecycle, string, string]>(
      `INSERT INTO status_incident_updates (id, incident_id, status, body, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.incidentId, input.status, input.body, createdAt);
    if (input.status === "resolved") {
      db.prepare<[string, string, string]>(
        `UPDATE status_incidents
            SET status = 'resolved', resolved_at = ?, updated_at = ?
          WHERE id = ?`,
      ).run(createdAt, createdAt, input.incidentId);
    } else {
      db.prepare<[IncidentLifecycle, string, string]>(
        `UPDATE status_incidents
            SET status = ?, resolved_at = NULL, updated_at = ?
          WHERE id = ?`,
      ).run(input.status, createdAt, input.incidentId);
    }
  });
  tx();
  const row = db
    .prepare<[string]>(`SELECT * FROM status_incident_updates WHERE id = ?`)
    .get(input.id) as StatusIncidentUpdateRow;
  return toUpdate(row);
}

export function listIncidentUpdates(
  db: Db,
  incidentId: string,
): StatusIncidentUpdate[] {
  const rows = db
    .prepare<[string]>(
      `SELECT * FROM status_incident_updates
        WHERE incident_id = ?
        ORDER BY created_at DESC`,
    )
    .all(incidentId) as StatusIncidentUpdateRow[];
  return rows.map(toUpdate);
}

export interface RecentUpdateForFeed {
  update: StatusIncidentUpdate;
  incident: StatusIncident;
}

export function listRecentUpdatesForFeed(
  db: Db,
  limit: number,
): RecentUpdateForFeed[] {
  ensureStatusPageSchema(db);
  const rows = db
    .prepare<[number]>(
      `SELECT u.id           AS u_id,
              u.incident_id  AS u_incident_id,
              u.status       AS u_status,
              u.body         AS u_body,
              u.created_at   AS u_created_at,
              i.id           AS i_id,
              i.title        AS i_title,
              i.status       AS i_status,
              i.impact       AS i_impact,
              i.started_at   AS i_started_at,
              i.resolved_at  AS i_resolved_at,
              i.created_at   AS i_created_at,
              i.updated_at   AS i_updated_at
         FROM status_incident_updates u
         JOIN status_incidents i ON i.id = u.incident_id
        ORDER BY u.created_at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(limit, 200))) as Array<
      Record<string, string | null>
    >;
  return rows.map((r) => ({
    update: toUpdate({
      id: r.u_id as string,
      incident_id: r.u_incident_id as string,
      status: r.u_status as IncidentLifecycle,
      body: r.u_body as string,
      created_at: r.u_created_at as string,
    }),
    incident: toIncident({
      id: r.i_id as string,
      title: r.i_title as string,
      status: r.i_status as IncidentLifecycle,
      impact: r.i_impact as IncidentImpact,
      started_at: r.i_started_at as string,
      resolved_at: r.i_resolved_at ?? null,
      created_at: r.i_created_at as string,
      updated_at: r.i_updated_at as string,
    }),
  }));
}
