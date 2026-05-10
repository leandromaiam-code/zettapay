import type { Database as Db } from "better-sqlite3";

export interface TpvWindow {
  amount: number;
  count: number;
}

export interface TpvBreakdown {
  today: TpvWindow;
  week: TpvWindow;
  month: TpvWindow;
}

export interface TpvSeriesPoint {
  date: string;
  amount: number;
  count: number;
}

export interface TopCustomer {
  payerWallet: string;
  totalUsdc: number;
  txCount: number;
  lastPaymentAt: string;
}

export interface ConversionStats {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  rate: number;
}

export interface AnalyticsResult {
  generatedAt: string;
  tpv: TpvBreakdown;
  tpvSeries: TpvSeriesPoint[];
  mrr: number;
  conversion: ConversionStats;
  topCustomers: TopCustomer[];
}

const SERIES_DAYS = 30;
const TOP_CUSTOMERS_LIMIT = 5;

interface PaymentSumRow {
  total: number | null;
  cnt: number;
}

interface SeriesRow {
  day: string;
  total: number | null;
  cnt: number;
}

interface CustomerRow {
  payer_wallet: string;
  total: number | null;
  cnt: number;
  last_at: string;
}

interface CountRow {
  status: "pending" | "processing" | "completed" | "failed" | "refunded";
  cnt: number;
}

function startOfUtcDay(now: Date): Date {
  const d = new Date(now.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function sumSince(db: Db, merchantId: string, sinceIso: string): TpvWindow {
  const row = db
    .prepare<[string, string]>(
      `SELECT COALESCE(SUM(amount_usdc), 0) AS total, COUNT(*) AS cnt
       FROM payments
       WHERE merchant_id = ?
         AND status = 'completed'
         AND created_at >= ?`,
    )
    .get(merchantId, sinceIso) as PaymentSumRow | undefined;
  return {
    amount: Number(row?.total ?? 0),
    count: Number(row?.cnt ?? 0),
  };
}

function dailySeries(
  db: Db,
  merchantId: string,
  sinceIso: string,
): SeriesRow[] {
  return db
    .prepare<[string, string]>(
      `SELECT substr(created_at, 1, 10) AS day,
              COALESCE(SUM(amount_usdc), 0) AS total,
              COUNT(*) AS cnt
       FROM payments
       WHERE merchant_id = ?
         AND status = 'completed'
         AND created_at >= ?
       GROUP BY day
       ORDER BY day ASC`,
    )
    .all(merchantId, sinceIso) as SeriesRow[];
}

function fillSeries(rows: SeriesRow[], from: Date): TpvSeriesPoint[] {
  const byDay = new Map<string, SeriesRow>();
  for (const r of rows) byDay.set(r.day, r);
  const out: TpvSeriesPoint[] = [];
  for (let i = 0; i < SERIES_DAYS; i++) {
    const d = new Date(from.getTime());
    d.setUTCDate(d.getUTCDate() + i);
    const key = d.toISOString().slice(0, 10);
    const row = byDay.get(key);
    out.push({
      date: key,
      amount: Number(row?.total ?? 0),
      count: Number(row?.cnt ?? 0),
    });
  }
  return out;
}

function topCustomers(
  db: Db,
  merchantId: string,
  monthStartIso: string,
): TopCustomer[] {
  const rows = db
    .prepare<[string, string, number]>(
      `SELECT payer_wallet,
              COALESCE(SUM(amount_usdc), 0) AS total,
              COUNT(*) AS cnt,
              MAX(COALESCE(completed_at, created_at)) AS last_at
       FROM payments
       WHERE merchant_id = ?
         AND status = 'completed'
         AND created_at >= ?
       GROUP BY payer_wallet
       ORDER BY total DESC, cnt DESC
       LIMIT ?`,
    )
    .all(merchantId, monthStartIso, TOP_CUSTOMERS_LIMIT) as CustomerRow[];
  return rows.map((r) => ({
    payerWallet: r.payer_wallet,
    totalUsdc: Number(r.total ?? 0),
    txCount: Number(r.cnt ?? 0),
    lastPaymentAt: r.last_at,
  }));
}

function conversion(
  db: Db,
  merchantId: string,
  sinceIso: string,
): ConversionStats {
  const rows = db
    .prepare<[string, string]>(
      `SELECT status, COUNT(*) AS cnt
       FROM payments
       WHERE merchant_id = ?
         AND created_at >= ?
       GROUP BY status`,
    )
    .all(merchantId, sinceIso) as CountRow[];
  let total = 0;
  let completed = 0;
  let failed = 0;
  let pending = 0;
  for (const r of rows) {
    const n = Number(r.cnt ?? 0);
    total += n;
    if (r.status === "completed") completed += n;
    else if (r.status === "failed") failed += n;
    else if (r.status === "pending" || r.status === "processing") pending += n;
  }
  const denom = completed + failed;
  const rate = denom > 0 ? completed / denom : 0;
  return { total, completed, failed, pending, rate };
}

function activeMrr(db: Db, merchantId: string): number {
  const row = db
    .prepare<[string]>(
      `SELECT COALESCE(SUM(
         CASE
           WHEN interval = 'monthly' THEN amount
           WHEN interval = 'weekly'  THEN amount * 52.0 / 12.0
           WHEN interval = 'daily'   THEN amount * 365.0 / 12.0
           ELSE 0
         END
       ), 0) AS total
       FROM subscriptions
       WHERE merchant_id = ? AND status = 'active'`,
    )
    .get(merchantId) as { total: number | null } | undefined;
  return Number(row?.total ?? 0);
}

export function computeAnalytics(
  db: Db,
  merchantId: string,
  now: Date = new Date(),
): AnalyticsResult {
  const todayStart = startOfUtcDay(now);
  const weekStart = new Date(todayStart.getTime());
  weekStart.setUTCDate(weekStart.getUTCDate() - 6); // last 7 days inclusive of today
  const monthStart = new Date(todayStart.getTime());
  monthStart.setUTCDate(monthStart.getUTCDate() - 29); // last 30 days inclusive

  const seriesStart = new Date(todayStart.getTime());
  seriesStart.setUTCDate(seriesStart.getUTCDate() - (SERIES_DAYS - 1));

  const tpv: TpvBreakdown = {
    today: sumSince(db, merchantId, todayStart.toISOString()),
    week: sumSince(db, merchantId, weekStart.toISOString()),
    month: sumSince(db, merchantId, monthStart.toISOString()),
  };

  const tpvSeries = fillSeries(
    dailySeries(db, merchantId, seriesStart.toISOString()),
    seriesStart,
  );

  return {
    generatedAt: now.toISOString(),
    tpv,
    tpvSeries,
    mrr: activeMrr(db, merchantId),
    conversion: conversion(db, merchantId, monthStart.toISOString()),
    topCustomers: topCustomers(db, merchantId, monthStart.toISOString()),
  };
}
