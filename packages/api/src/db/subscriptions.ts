import type { Database as Db } from "better-sqlite3";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";

export type SubscriptionStatus = "active" | "paused" | "canceled";
export type SubscriptionInterval = "daily" | "weekly" | "monthly";

export const SUBSCRIPTION_INTERVALS: readonly SubscriptionInterval[] = [
  "daily",
  "weekly",
  "monthly",
] as const;

export interface SubscriptionRow {
  id: string;
  merchant_id: string;
  customer_wallet: string;
  amount: number;
  currency: string;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  next_charge_at: string;
  last_charge_at: string | null;
  metadata_json: string | null;
  authorization_signature: string | null;
  authorization_public_key: string | null;
  authorization_signed_at: string | null;
  failed_charge_count: number | null;
  last_failure_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubscriptionAuthorization {
  signature: string;
  publicKey: string;
  signedAt: string;
}

export interface Subscription {
  id: string;
  merchantId: string;
  customerWallet: string;
  amount: number;
  currency: Currency;
  interval: SubscriptionInterval;
  status: SubscriptionStatus;
  nextChargeAt: string;
  lastChargeAt: string | null;
  metadata: Record<string, unknown>;
  authorization: SubscriptionAuthorization | null;
  failedChargeCount: number;
  lastFailureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateSubscriptionInput {
  id: string;
  merchantId: string;
  customerWallet: string;
  amount: number;
  interval: SubscriptionInterval;
  nextChargeAt: string;
  currency?: Currency;
  metadata?: Record<string, unknown> | null;
}

function toSubscription(row: SubscriptionRow): Subscription {
  const authorization: SubscriptionAuthorization | null =
    row.authorization_signature && row.authorization_public_key
      ? {
          signature: row.authorization_signature,
          publicKey: row.authorization_public_key,
          signedAt: row.authorization_signed_at ?? row.created_at,
        }
      : null;
  return {
    id: row.id,
    merchantId: row.merchant_id,
    customerWallet: row.customer_wallet,
    amount: row.amount,
    currency: (row.currency || DEFAULT_CURRENCY) as Currency,
    interval: row.interval,
    status: row.status,
    nextChargeAt: row.next_charge_at,
    lastChargeAt: row.last_charge_at,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
    authorization,
    failedChargeCount: row.failed_charge_count ?? 0,
    lastFailureReason: row.last_failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function isSubscriptionInterval(
  value: unknown,
): value is SubscriptionInterval {
  return (
    typeof value === "string" &&
    (SUBSCRIPTION_INTERVALS as readonly string[]).includes(value)
  );
}

export function advanceChargeDate(
  from: Date,
  interval: SubscriptionInterval,
): Date {
  const next = new Date(from.getTime());
  switch (interval) {
    case "daily":
      next.setUTCDate(next.getUTCDate() + 1);
      return next;
    case "weekly":
      next.setUTCDate(next.getUTCDate() + 7);
      return next;
    case "monthly":
      next.setUTCMonth(next.getUTCMonth() + 1);
      return next;
  }
}

export function insertSubscription(
  db: Db,
  input: CreateSubscriptionInput,
): Subscription {
  db.prepare<
    [
      string,
      string,
      string,
      number,
      string,
      SubscriptionInterval,
      string,
      string | null,
    ]
  >(
    `INSERT INTO subscriptions
       (id, merchant_id, customer_wallet, amount, currency, interval, status, next_charge_at, metadata_json)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
  ).run(
    input.id,
    input.merchantId,
    input.customerWallet,
    input.amount,
    input.currency ?? DEFAULT_CURRENCY,
    input.interval,
    input.nextChargeAt,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return getSubscription(db, input.id);
}

export function getSubscription(db: Db, id: string): Subscription {
  const row = db
    .prepare<[string]>("SELECT * FROM subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  if (!row) {
    throw new Error(`subscription ${id} not found`);
  }
  return toSubscription(row);
}

export function findSubscription(
  db: Db,
  id: string,
): Subscription | null {
  const row = db
    .prepare<[string]>("SELECT * FROM subscriptions WHERE id = ?")
    .get(id) as SubscriptionRow | undefined;
  return row ? toSubscription(row) : null;
}

export function listSubscriptionsByMerchant(
  db: Db,
  merchantId: string,
  limit = 50,
): Subscription[] {
  const rows = db
    .prepare<[string, number]>(
      `SELECT * FROM subscriptions
         WHERE merchant_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
    )
    .all(merchantId, limit) as SubscriptionRow[];
  return rows.map(toSubscription);
}

export function listDueSubscriptions(
  db: Db,
  nowIso: string,
  limit = 100,
): Subscription[] {
  const rows = db
    .prepare<[string, number]>(
      `SELECT * FROM subscriptions
         WHERE status = 'active' AND next_charge_at <= ?
         ORDER BY next_charge_at ASC
         LIMIT ?`,
    )
    .all(nowIso, limit) as SubscriptionRow[];
  return rows.map(toSubscription);
}

export function updateSubscriptionStatus(
  db: Db,
  id: string,
  status: SubscriptionStatus,
): Subscription {
  const result = db
    .prepare<[SubscriptionStatus, string]>(
      `UPDATE subscriptions
         SET status = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
    )
    .run(status, id);
  if (result.changes === 0) {
    throw new Error(`subscription ${id} not found`);
  }
  return getSubscription(db, id);
}

export function recordSubscriptionCharge(
  db: Db,
  id: string,
  chargedAt: string,
  nextChargeAt: string,
): Subscription {
  const result = db
    .prepare<[string, string, string]>(
      `UPDATE subscriptions
         SET last_charge_at = ?,
             next_charge_at = ?,
             failed_charge_count = 0,
             last_failure_reason = NULL,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
    )
    .run(chargedAt, nextChargeAt, id);
  if (result.changes === 0) {
    throw new Error(`subscription ${id} not found`);
  }
  return getSubscription(db, id);
}

export interface SetAuthorizationInput {
  signature: string;
  publicKey: string;
}

export function setSubscriptionAuthorization(
  db: Db,
  id: string,
  input: SetAuthorizationInput,
): Subscription {
  const result = db
    .prepare<[string, string, string]>(
      `UPDATE subscriptions
         SET authorization_signature = ?,
             authorization_public_key = ?,
             authorization_signed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
    )
    .run(input.signature, input.publicKey, id);
  if (result.changes === 0) {
    throw new Error(`subscription ${id} not found`);
  }
  return getSubscription(db, id);
}

/**
 * Record a charge failure. After three consecutive failures the subscription
 * is auto-paused so the cron worker stops re-trying a permanently broken
 * authorization (revoked wallet, drained balance, mutated binding).
 */
export function recordSubscriptionFailure(
  db: Db,
  id: string,
  reason: string,
  pauseAfter = 3,
): Subscription {
  const incremented = db
    .prepare<[string, string]>(
      `UPDATE subscriptions
         SET failed_charge_count = COALESCE(failed_charge_count, 0) + 1,
             last_failure_reason = ?,
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`,
    )
    .run(reason, id);
  if (incremented.changes === 0) {
    throw new Error(`subscription ${id} not found`);
  }
  const current = getSubscription(db, id);
  if (current.failedChargeCount >= pauseAfter && current.status === "active") {
    return updateSubscriptionStatus(db, id, "paused");
  }
  return current;
}
