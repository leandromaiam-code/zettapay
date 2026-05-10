import type { Database as Db } from "better-sqlite3";

export type WebhookStatus = "pending" | "sent" | "failed" | "dead";

export type WebhookDeadLetterReason =
  | "retries_exhausted"
  | "non_retryable_status";

export interface WebhookEventRow {
  id: string;
  event_id: string;
  url: string;
  payload_json: string;
  status: WebhookStatus;
  attempt_count: number;
  max_attempts: number;
  last_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  dead_letter_reason: WebhookDeadLetterReason | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WebhookEvent {
  id: string;
  eventId: string;
  url: string;
  payload: unknown;
  status: WebhookStatus;
  attemptCount: number;
  maxAttempts: number;
  lastAttemptAt: string | null;
  lastStatusCode: number | null;
  lastError: string | null;
  deadLetterReason: WebhookDeadLetterReason | null;
  deliveredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWebhookEventInput {
  id: string;
  eventId: string;
  url: string;
  payload: unknown;
  maxAttempts: number;
}

export interface RecordAttemptInput {
  eventId: string;
  attempt: number;
  statusCode: number | null;
  error: string | null;
  attemptedAt: string;
}

export interface FinalizeInput {
  eventId: string;
  status: Extract<WebhookStatus, "sent" | "failed" | "dead">;
  deadLetterReason?: WebhookDeadLetterReason | null;
  deliveredAt?: string | null;
}

function toEvent(row: WebhookEventRow): WebhookEvent {
  return {
    id: row.id,
    eventId: row.event_id,
    url: row.url,
    payload: JSON.parse(row.payload_json),
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastAttemptAt: row.last_attempt_at,
    lastStatusCode: row.last_status_code,
    lastError: row.last_error,
    deadLetterReason: row.dead_letter_reason,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createWebhookEvent(
  db: Db,
  input: CreateWebhookEventInput,
): WebhookEvent {
  db.prepare<[string, string, string, string, number]>(
    `INSERT INTO webhook_events
       (id, event_id, url, payload_json, status, max_attempts)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
  ).run(
    input.id,
    input.eventId,
    input.url,
    JSON.stringify(input.payload ?? null),
    input.maxAttempts,
  );
  return getWebhookEventByEventId(db, input.eventId)!;
}

export function recordAttempt(db: Db, input: RecordAttemptInput): void {
  db.prepare<[number, string, number | null, string | null, string, string]>(
    `UPDATE webhook_events
        SET attempt_count    = ?,
            last_attempt_at  = ?,
            last_status_code = ?,
            last_error       = ?,
            updated_at       = ?
      WHERE event_id = ?`,
  ).run(
    input.attempt,
    input.attemptedAt,
    input.statusCode,
    input.error,
    input.attemptedAt,
    input.eventId,
  );
}

export function finalizeWebhookEvent(db: Db, input: FinalizeInput): void {
  const nowIso = new Date().toISOString();
  db.prepare<
    [
      WebhookStatus,
      WebhookDeadLetterReason | null,
      string | null,
      string,
      string,
    ]
  >(
    `UPDATE webhook_events
        SET status             = ?,
            dead_letter_reason = ?,
            delivered_at       = ?,
            updated_at         = ?
      WHERE event_id = ?`,
  ).run(
    input.status,
    input.deadLetterReason ?? null,
    input.deliveredAt ?? (input.status === "sent" ? nowIso : null),
    nowIso,
    input.eventId,
  );
}

export function getWebhookEventByEventId(
  db: Db,
  eventId: string,
): WebhookEvent | null {
  const row = db
    .prepare<[string]>("SELECT * FROM webhook_events WHERE event_id = ?")
    .get(eventId) as WebhookEventRow | undefined;
  return row ? toEvent(row) : null;
}

export interface ListWebhookEventsOptions {
  status?: WebhookStatus;
  limit?: number;
}

export function listWebhookEvents(
  db: Db,
  options: ListWebhookEventsOptions = {},
): WebhookEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  if (options.status) {
    const rows = db
      .prepare<[WebhookStatus, number]>(
        "SELECT * FROM webhook_events WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(options.status, limit) as WebhookEventRow[];
    return rows.map(toEvent);
  }
  const rows = db
    .prepare<[number]>(
      "SELECT * FROM webhook_events ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit) as WebhookEventRow[];
  return rows.map(toEvent);
}

export interface ListWebhookEventsByUrlOptions {
  status?: WebhookStatus;
  limit?: number;
}

/**
 * List webhook events delivered to a specific URL. Used by the merchant
 * dashboard to scope the timeline to the caller's own webhook endpoint —
 * `webhook_events` does not store `merchant_id` so the URL is the join key.
 */
export function listWebhookEventsByUrl(
  db: Db,
  url: string,
  options: ListWebhookEventsByUrlOptions = {},
): WebhookEvent[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  if (options.status) {
    const rows = db
      .prepare<[string, WebhookStatus, number]>(
        "SELECT * FROM webhook_events WHERE url = ? AND status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(url, options.status, limit) as WebhookEventRow[];
    return rows.map(toEvent);
  }
  const rows = db
    .prepare<[string, number]>(
      "SELECT * FROM webhook_events WHERE url = ? ORDER BY created_at DESC LIMIT ?",
    )
    .all(url, limit) as WebhookEventRow[];
  return rows.map(toEvent);
}

export interface AdminListWebhookEventsOptions {
  status?: WebhookStatus;
  url?: string;
  eventId?: string;
  limit?: number;
  offset?: number;
}

export interface AdminListWebhookEventsResult {
  events: WebhookEvent[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Admin-scoped listing across all webhook destinations. Unlike
 * `listWebhookEventsByUrl`, this accepts arbitrary filters and exposes the
 * total row count so the dashboard can paginate. Auth is enforced at the
 * route layer via `adminAuth` — never expose this to merchant API keys.
 */
export function listAllWebhookEvents(
  db: Db,
  options: AdminListWebhookEventsOptions = {},
): AdminListWebhookEventsResult {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.url) {
    clauses.push("url = ?");
    params.push(options.url);
  }
  if (options.eventId) {
    clauses.push("event_id = ?");
    params.push(options.eventId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM webhook_events ${where}`)
    .get(...params) as { n: number | bigint };
  const rows = db
    .prepare(
      `SELECT * FROM webhook_events ${where} ORDER BY datetime(created_at) DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as WebhookEventRow[];
  return {
    events: rows.map(toEvent),
    total: Number(totalRow.n),
    limit,
    offset,
  };
}

export interface WebhookEventCounts {
  pending: number;
  sent: number;
  failed: number;
  dead: number;
  total: number;
}

/**
 * Admin dashboard summary — counts grouped by `status`. Cheap on SQLite
 * (single grouped scan) and avoids paging through the full table just to
 * render the headline tiles.
 */
export function countWebhookEventsByStatus(db: Db): WebhookEventCounts {
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS n FROM webhook_events GROUP BY status",
    )
    .all() as Array<{ status: WebhookStatus; n: number | bigint }>;
  const counts: WebhookEventCounts = {
    pending: 0,
    sent: 0,
    failed: 0,
    dead: 0,
    total: 0,
  };
  for (const row of rows) {
    const n = Number(row.n);
    counts.total += n;
    if (row.status in counts) {
      counts[row.status as keyof Omit<WebhookEventCounts, "total">] = n;
    }
  }
  return counts;
}

/**
 * Reset a finalized webhook event back to `pending` so the dispatcher can run
 * it again. Used by the manual retry endpoint — the `event_id` and payload
 * stay stable across retries (idempotency is preserved on the merchant side).
 */
export function resetWebhookEventForRetry(db: Db, eventId: string): void {
  const nowIso = new Date().toISOString();
  db.prepare<[string, string]>(
    `UPDATE webhook_events
        SET status             = 'pending',
            attempt_count      = 0,
            last_attempt_at    = NULL,
            last_status_code   = NULL,
            last_error         = NULL,
            dead_letter_reason = NULL,
            delivered_at       = NULL,
            updated_at         = ?
      WHERE event_id = ?`,
  ).run(nowIso, eventId);
}
