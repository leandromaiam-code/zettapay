import type { Database as Db } from "better-sqlite3";

export type FunnelEventType = "view" | "checkout" | "completed";

export interface FunnelEventRow {
  id: string;
  merchant_id: string;
  session_id: string;
  event_type: FunnelEventType;
  payment_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface FunnelEvent {
  id: string;
  merchantId: string;
  sessionId: string;
  eventType: FunnelEventType;
  paymentId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface InsertFunnelEventInput {
  id: string;
  merchantId: string;
  sessionId: string;
  eventType: FunnelEventType;
  paymentId?: string | null;
  metadata?: Record<string, unknown> | null;
}

function toFunnelEvent(row: FunnelEventRow): FunnelEvent {
  return {
    id: row.id,
    merchantId: row.merchant_id,
    sessionId: row.session_id,
    eventType: row.event_type,
    paymentId: row.payment_id,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    createdAt: row.created_at,
  };
}

/**
 * Inserts a funnel event. The (merchant_id, session_id, event_type) unique
 * index dedupes so a refresh on the checkout page does not inflate the
 * `view` count beyond unique sessions. When a duplicate would be inserted
 * the existing event is returned unchanged — funnel tracking is idempotent.
 */
export function recordFunnelEvent(
  db: Db,
  input: InsertFunnelEventInput,
): FunnelEvent {
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  const result = db
    .prepare(
      `INSERT INTO funnel_events (
         id, merchant_id, session_id, event_type, payment_id, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(merchant_id, session_id, event_type) DO NOTHING`,
    )
    .run(
      input.id,
      input.merchantId,
      input.sessionId,
      input.eventType,
      input.paymentId ?? null,
      metadataJson,
    );

  const row =
    result.changes > 0
      ? (db
          .prepare<[string]>("SELECT * FROM funnel_events WHERE id = ?")
          .get(input.id) as FunnelEventRow | undefined)
      : (db
          .prepare<[string, string, FunnelEventType]>(
            `SELECT * FROM funnel_events
             WHERE merchant_id = ? AND session_id = ? AND event_type = ?`,
          )
          .get(input.merchantId, input.sessionId, input.eventType) as
          | FunnelEventRow
          | undefined);

  if (!row) {
    throw new Error("funnel_event insert/lookup failed");
  }
  return toFunnelEvent(row);
}

export interface FunnelStepCounts {
  view: number;
  checkout: number;
  completed: number;
}

interface CountRow {
  event_type: FunnelEventType;
  cnt: number;
}

export function countFunnelEvents(
  db: Db,
  merchantId: string,
  sinceIso: string,
): FunnelStepCounts {
  const rows = db
    .prepare<[string, string]>(
      `SELECT event_type, COUNT(*) AS cnt
       FROM funnel_events
       WHERE merchant_id = ? AND created_at >= ?
       GROUP BY event_type`,
    )
    .all(merchantId, sinceIso) as CountRow[];

  const counts: FunnelStepCounts = { view: 0, checkout: 0, completed: 0 };
  for (const r of rows) {
    counts[r.event_type] = Number(r.cnt ?? 0);
  }
  return counts;
}
