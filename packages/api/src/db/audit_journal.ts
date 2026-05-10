import type { Database as Db } from "better-sqlite3";

export interface AuditJournalRow {
  id: number;
  actor: string;
  event: string;
  entity_type: string | null;
  entity_id: string | null;
  reason: string | null;
  payload: string | null;
  created_at: string;
}

export interface AuditJournalEntry {
  id: number;
  actor: string;
  event: string;
  entityType: string | null;
  entityId: string | null;
  reason: string | null;
  payload: unknown;
  createdAt: string;
}

export interface AppendAuditInput {
  actor: string;
  event: string;
  entityType?: string | null;
  entityId?: string | null;
  reason?: string | null;
  payload?: unknown;
}

function toEntry(row: AuditJournalRow): AuditJournalEntry {
  return {
    id: row.id,
    actor: row.actor,
    event: row.event,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    createdAt: row.created_at,
  };
}

/**
 * Append-only audit record. Premissa #24 (audit-ready) — every sensitive
 * decision (KYC reviews, settlement enable/disable, agent revocation, registry
 * publishing, payment failures) lands here with the actor that authorized it,
 * the affected entity, and a reason. Rows are never UPDATE/DELETEd, enforced
 * by triggers in db/index.ts.
 */
export function appendAudit(db: Db, input: AppendAuditInput): AuditJournalEntry {
  const result = db
    .prepare<
      [string, string, string | null, string | null, string | null, string | null]
    >(
      "INSERT INTO audit_journal (actor, event, entity_type, entity_id, reason, payload) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(
      input.actor,
      input.event,
      input.entityType ?? null,
      input.entityId ?? null,
      input.reason ?? null,
      input.payload === undefined ? null : JSON.stringify(input.payload),
    );
  const row = db
    .prepare<[number | bigint]>("SELECT * FROM audit_journal WHERE id = ?")
    .get(result.lastInsertRowid) as AuditJournalRow | undefined;
  if (!row) {
    throw new Error("audit journal entry inserted but not retrievable");
  }
  return toEntry(row);
}

export interface ListAuditOptions {
  actor?: string;
  event?: string;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export function listAuditEntries(
  db: Db,
  options: ListAuditOptions = {},
): AuditJournalEntry[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.actor) {
    clauses.push("actor = ?");
    params.push(options.actor);
  }
  if (options.event) {
    clauses.push("event = ?");
    params.push(options.event);
  }
  if (options.entityType) {
    clauses.push("entity_type = ?");
    params.push(options.entityType);
  }
  if (options.entityId) {
    clauses.push("entity_id = ?");
    params.push(options.entityId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit);
  const rows = db
    .prepare(
      `SELECT * FROM audit_journal ${where} ORDER BY id DESC LIMIT ?`,
    )
    .all(...params) as AuditJournalRow[];
  return rows.map(toEntry);
}
