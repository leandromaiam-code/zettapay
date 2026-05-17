import type { Database as Db } from "better-sqlite3";
import { Counter, registry } from "../lib/metrics.js";
import { logger as defaultLogger, type Logger } from "../lib/logger.js";
import { Sentry, isSentryEnabled } from "../lib/sentry.js";

/**
 * Z30.3 — 24/7 program health monitor.
 *
 * Runs every 5 minutes alongside the subscription cron. Inspects four signals
 * computed from the local DB (payments + audit_journal — both fed by the
 * existing Helius/Geyser webhook pipeline, so we stay inside Helius free-tier
 * limits and pay no extra RPC for the check):
 *
 *   1. error-rate over the rolling window (default last 60 min). Payments
 *      with `status='failed'` divided by completed+failed.
 *   2. invoice/payment stuck — rows in `pending` or `processing` past the
 *      `stuckInvoiceMs` threshold (1h). Indirect signal that the chain side
 *      of the flow failed or the sweep cron is lagging.
 *   3. sweep failures — `audit_journal` events whose name starts with
 *      `sweep.failed`. The cron worker that signs sweeps writes those rows.
 *   4. suspicious account-close — `audit_journal` events
 *      `account.close_suspect` (or any `*.account.close*` event) raised by
 *      the indexer when a webhook reports a program account closure that
 *      doesn't match an expected sweep.
 *
 * When any signal breaches its threshold the monitor pages a human via the
 * provider-agnostic WhatsApp webhook (Twilio / Evolution / Meta Cloud / Z-API
 * — same contract as scripts/notify-mainnet-ready.sh). Same Stripe-style
 * dedup as synthetic_monitor: alert once per kind on transition into-breach,
 * clear once recovered, never spam every 5-minute tick while still in breach.
 */

const monitorTicksTotal = registry.register(
  new Counter(
    "zettapay_program_monitor_ticks_total",
    "Total program-health monitor evaluations, labeled by terminal outcome.",
    ["outcome"],
  ),
);

const monitorAlertsTotal = registry.register(
  new Counter(
    "zettapay_program_monitor_alerts_total",
    "Number of program-health alerts raised, labeled by kind.",
    ["kind"],
  ),
);

const monitorNotifierFailuresTotal = registry.register(
  new Counter(
    "zettapay_program_monitor_notifier_failures_total",
    "Total WhatsApp notifier failures (delivery did not reach the operator).",
    ["reason"],
  ),
);

export type AlertKind =
  | "error_rate"
  | "invoice_stuck"
  | "sweep_failed"
  | "account_close";

export type AlertSeverity = "warning" | "critical";

export interface ProgramHealthAlert {
  kind: AlertKind;
  severity: AlertSeverity;
  message: string;
  detail: Record<string, unknown>;
}

export interface ProgramHealthMetrics {
  /** Settled payments (completed or failed) inside the error-rate window. */
  totalSettled: number;
  failedPayments: number;
  /** Error-rate as a percentage (0-100), `0` when `totalSettled === 0`. */
  errorRatePct: number;
  /** Count of payments in pending/processing past the stuck threshold. */
  stuckCount: number;
  /** Age in ms of the oldest stuck payment, `null` when there are none. */
  stuckOldestAgeMs: number | null;
  /** Sweep-failure audit events inside the lookback window. */
  sweepFailures: number;
  /** Suspicious account-close audit events inside the lookback window. */
  suspiciousAccountCloses: number;
}

export interface ProgramHealthSnapshot {
  generatedAt: string;
  windowStartedAt: string;
  metrics: ProgramHealthMetrics;
  alerts: ProgramHealthAlert[];
}

export interface ProgramMonitorThresholds {
  /** Error-rate breach threshold, percentage 0-100. Default 1. */
  errorRatePct: number;
  /** Minimum settled payments before the rate gate fires (anti-noise). */
  errorRateMinSamples: number;
  /** Pending/processing age past which a payment is "stuck", ms. Default 1h. */
  stuckInvoiceMs: number;
  /** Rolling lookback window for rate/event aggregates, ms. Default 1h. */
  windowMs: number;
}

export const DEFAULT_THRESHOLDS: ProgramMonitorThresholds = {
  errorRatePct: 1,
  errorRateMinSamples: 20,
  stuckInvoiceMs: 60 * 60 * 1000,
  windowMs: 60 * 60 * 1000,
};

const SWEEP_FAILED_EVENTS = ["sweep.failed", "program.sweep.failed"] as const;
const ACCOUNT_CLOSE_EVENTS = [
  "account.close_suspect",
  "program.account.closed",
  "indexer.account_close_suspect",
] as const;

interface PaymentRateRow {
  total: number;
  failed: number;
}

interface StuckPaymentRow {
  count: number;
  oldest: string | null;
}

function countPaymentsInWindow(
  db: Db,
  windowStartIso: string,
): PaymentRateRow {
  const row = db
    .prepare<[string]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM payments
       WHERE created_at >= ?
         AND status IN ('completed','failed')`,
    )
    .get(windowStartIso) as { total: number; failed: number | null };
  return { total: row.total, failed: row.failed ?? 0 };
}

function countStuckPayments(
  db: Db,
  thresholdIso: string,
): StuckPaymentRow {
  const row = db
    .prepare<[string]>(
      `SELECT
         COUNT(*) AS count,
         MIN(created_at) AS oldest
       FROM payments
       WHERE status IN ('pending','processing')
         AND created_at < ?`,
    )
    .get(thresholdIso) as { count: number; oldest: string | null };
  return { count: row.count, oldest: row.oldest };
}

function countAuditEventsSince(
  db: Db,
  events: readonly string[],
  sinceIso: string,
): number {
  if (events.length === 0) return 0;
  const placeholders = events.map(() => "?").join(",");
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM audit_journal
       WHERE event IN (${placeholders})
         AND created_at >= ?`,
    )
    .get(...events, sinceIso) as { n: number };
  return row.n;
}

/**
 * Evaluate program health against the local DB. Pure read — never writes,
 * never throws. Side-effect-free so it can be unit-tested with an in-memory
 * SQLite and chained from `/admin/program-health` for on-demand inspection.
 */
export function evaluateProgramHealth(
  db: Db,
  options: {
    thresholds?: Partial<ProgramMonitorThresholds>;
    now?: () => number;
  } = {},
): ProgramHealthSnapshot {
  const thresholds: ProgramMonitorThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...options.thresholds,
  };
  const now = options.now ?? Date.now;
  const nowMs = now();
  const windowStartMs = nowMs - thresholds.windowMs;
  const stuckCutoffMs = nowMs - thresholds.stuckInvoiceMs;
  const windowStartIso = new Date(windowStartMs).toISOString();
  const stuckCutoffIso = new Date(stuckCutoffMs).toISOString();

  const rate = countPaymentsInWindow(db, windowStartIso);
  const stuck = countStuckPayments(db, stuckCutoffIso);
  const sweepFailures = countAuditEventsSince(
    db,
    SWEEP_FAILED_EVENTS,
    windowStartIso,
  );
  const suspiciousAccountCloses = countAuditEventsSince(
    db,
    ACCOUNT_CLOSE_EVENTS,
    windowStartIso,
  );

  const errorRatePct =
    rate.total === 0 ? 0 : (rate.failed / rate.total) * 100;
  const stuckOldestAgeMs = stuck.oldest
    ? Math.max(0, nowMs - new Date(stuck.oldest).getTime())
    : null;

  const alerts: ProgramHealthAlert[] = [];

  if (
    rate.total >= thresholds.errorRateMinSamples &&
    errorRatePct > thresholds.errorRatePct
  ) {
    alerts.push({
      kind: "error_rate",
      severity: "critical",
      message: `error rate ${errorRatePct.toFixed(2)}% > threshold ${thresholds.errorRatePct}%`,
      detail: {
        errorRatePct,
        failedPayments: rate.failed,
        totalSettled: rate.total,
        windowMs: thresholds.windowMs,
      },
    });
  }

  if (stuck.count > 0 && stuckOldestAgeMs !== null) {
    alerts.push({
      kind: "invoice_stuck",
      severity: "warning",
      message: `${stuck.count} payment(s) stuck > ${Math.floor(thresholds.stuckInvoiceMs / 60_000)}min, oldest ${Math.floor(stuckOldestAgeMs / 60_000)}min`,
      detail: {
        stuckCount: stuck.count,
        oldestAgeMs: stuckOldestAgeMs,
        thresholdMs: thresholds.stuckInvoiceMs,
      },
    });
  }

  if (sweepFailures > 0) {
    alerts.push({
      kind: "sweep_failed",
      severity: "critical",
      message: `${sweepFailures} sweep failure(s) in last ${Math.floor(thresholds.windowMs / 60_000)}min`,
      detail: { sweepFailures, windowMs: thresholds.windowMs },
    });
  }

  if (suspiciousAccountCloses > 0) {
    alerts.push({
      kind: "account_close",
      severity: "critical",
      message: `${suspiciousAccountCloses} suspicious account-close event(s) detected`,
      detail: {
        suspiciousAccountCloses,
        windowMs: thresholds.windowMs,
      },
    });
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    windowStartedAt: windowStartIso,
    metrics: {
      totalSettled: rate.total,
      failedPayments: rate.failed,
      errorRatePct,
      stuckCount: stuck.count,
      stuckOldestAgeMs,
      sweepFailures,
      suspiciousAccountCloses,
    },
    alerts,
  };
}

export interface WhatsAppNotifier {
  send(
    message: string,
    meta: { alert: ProgramHealthAlert; snapshot: ProgramHealthSnapshot },
  ): Promise<void>;
}

export interface HttpWhatsAppNotifierOptions {
  /** Webhook URL (Twilio/Evolution/Meta Cloud/Z-API endpoint). */
  url: string;
  /** Operator number in E.164 — "to" field on the WhatsApp message. */
  operatorNumber: string;
  /** Optional bearer token for the webhook auth header. */
  token?: string;
  /** Optional `from` number for providers that require it (Twilio). */
  fromNumber?: string;
  /** Per-request timeout in ms. Default 5_000. */
  timeoutMs?: number;
  /** Test seam. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * HTTP WhatsApp notifier. Wire-compatible with the body shape used by
 * scripts/notify-mainnet-ready.sh — the WhatsApp Cloud API "text" message
 * envelope, with the operator number and an optional `from`.
 *
 * Single-shot: no retry inside the notifier. If the upstream provider 429s
 * or 5xxs, the monitor records the failure and the next tick is the natural
 * retry — we deliberately don't queue retries because double-paging at 3am
 * is worse than missing one tick.
 */
export function createHttpWhatsAppNotifier(
  options: HttpWhatsAppNotifierOptions,
): WhatsAppNotifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = Math.max(100, options.timeoutMs ?? 5_000);
  return {
    async send(message) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json",
      };
      if (options.token) {
        headers["authorization"] = `Bearer ${options.token}`;
      }
      const body: Record<string, unknown> = {
        messaging_product: "whatsapp",
        to: options.operatorNumber,
        type: "text",
        text: { preview_url: false, body: message },
      };
      if (options.fromNumber) body["from"] = options.fromNumber;
      try {
        const response = await fetchImpl(options.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          // Drain to keep keep-alive sane on providers that pipeline.
          try {
            await response.text();
          } catch {
            // ignore
          }
          throw new Error(
            `whatsapp webhook responded ${response.status}`,
          );
        }
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export interface ProgramMonitorOptions {
  db: Db;
  /** Poll cadence. Floored to 60_000 (one minute) to keep DB scans cheap. */
  intervalMs?: number;
  thresholds?: Partial<ProgramMonitorThresholds>;
  /** When omitted alerts are logged + Sentry'd only; no WhatsApp paging. */
  notifier?: WhatsAppNotifier;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
  logger?: Logger;
  /** Test seam — called after every tick with the computed snapshot. */
  onResult?: (snapshot: ProgramHealthSnapshot) => void | Promise<void>;
}

export interface ProgramMonitorHandle {
  close(): Promise<void>;
  tick(): Promise<ProgramHealthSnapshot>;
  state(): { raised: Record<AlertKind, boolean> };
}

const MIN_INTERVAL_MS = 60_000;
const DEFAULT_INTERVAL_MS = 5 * 60_000;

function buildMessage(
  alert: ProgramHealthAlert,
  snapshot: ProgramHealthSnapshot,
): string {
  return [
    "ZettaPay alerta: " + alert.kind,
    "severidade: " + alert.severity,
    alert.message,
    "geracao: " + snapshot.generatedAt,
    "janela: " + snapshot.windowStartedAt + " → agora",
    "metrics: " +
      `error_rate=${snapshot.metrics.errorRatePct.toFixed(2)}% ` +
      `failed=${snapshot.metrics.failedPayments}/${snapshot.metrics.totalSettled} ` +
      `stuck=${snapshot.metrics.stuckCount} ` +
      `sweep_failed=${snapshot.metrics.sweepFailures} ` +
      `account_close=${snapshot.metrics.suspiciousAccountCloses}`,
  ].join("\n");
}

export function startProgramMonitor(
  options: ProgramMonitorOptions,
): ProgramMonitorHandle {
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
  );
  const log = options.logger ?? defaultLogger;
  const raised: Record<AlertKind, boolean> = {
    error_rate: false,
    invoice_stuck: false,
    sweep_failed: false,
    account_close: false,
  };
  let running = false;
  let stopped = false;
  let lastTick: Promise<unknown> = Promise.resolve();

  const fireNotifier = async (
    alert: ProgramHealthAlert,
    snapshot: ProgramHealthSnapshot,
  ): Promise<void> => {
    if (!options.notifier) return;
    try {
      await options.notifier.send(buildMessage(alert, snapshot), {
        alert,
        snapshot,
      });
    } catch (err) {
      const reason =
        err instanceof Error ? err.message.slice(0, 64) : "unknown";
      monitorNotifierFailuresTotal.inc({ reason }, 1);
      log.error("program_monitor.notifier_failed", {
        kind: alert.kind,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onAlertRaised = async (
    alert: ProgramHealthAlert,
    snapshot: ProgramHealthSnapshot,
  ): Promise<void> => {
    raised[alert.kind] = true;
    monitorAlertsTotal.inc({ kind: alert.kind }, 1);
    log.error("program_monitor.alert_raised", {
      kind: alert.kind,
      severity: alert.severity,
      message: alert.message,
      detail: alert.detail,
    });
    if (isSentryEnabled()) {
      try {
        Sentry.captureMessage(`program_monitor: ${alert.kind}`, {
          level: alert.severity === "critical" ? "error" : "warning",
          tags: { kind: alert.kind, severity: alert.severity },
          extra: { ...alert.detail, snapshot },
        });
      } catch {
        // Sentry is best-effort.
      }
    }
    await fireNotifier(alert, snapshot);
  };

  const onAlertCleared = (kind: AlertKind): void => {
    raised[kind] = false;
    log.info("program_monitor.alert_cleared", { kind });
    if (isSentryEnabled()) {
      try {
        Sentry.captureMessage(`program_monitor: ${kind} cleared`, {
          level: "info",
          tags: { kind },
        });
      } catch {
        // best-effort
      }
    }
  };

  const runOnce = async (): Promise<ProgramHealthSnapshot> => {
    let snapshot: ProgramHealthSnapshot;
    try {
      snapshot = evaluateProgramHealth(options.db, {
        ...(options.thresholds ? { thresholds: options.thresholds } : {}),
        ...(options.now ? { now: options.now } : {}),
      });
    } catch (err) {
      // evaluateProgramHealth is pure-read, but be defensive against DB errors
      // (e.g. database closed during shutdown) so the loop never crashes.
      monitorTicksTotal.inc({ outcome: "error" }, 1);
      log.error("program_monitor.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const firedKinds = new Set<AlertKind>(snapshot.alerts.map((a) => a.kind));
    for (const alert of snapshot.alerts) {
      if (!raised[alert.kind]) {
        await onAlertRaised(alert, snapshot);
      }
    }
    for (const kind of Object.keys(raised) as AlertKind[]) {
      if (raised[kind] && !firedKinds.has(kind)) {
        onAlertCleared(kind);
      }
    }

    monitorTicksTotal.inc(
      { outcome: snapshot.alerts.length > 0 ? "alerting" : "ok" },
      1,
    );

    if (options.onResult) {
      try {
        await options.onResult(snapshot);
      } catch (err) {
        log.error("program_monitor.on_result_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return snapshot;
  };

  const guardedTick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      log.error("program_monitor.tick_crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    lastTick = guardedTick();
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  log.info("program_monitor.started", {
    intervalMs,
    thresholds: { ...DEFAULT_THRESHOLDS, ...options.thresholds },
    notifier: options.notifier ? "configured" : "disabled",
  });

  return {
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await lastTick;
    },
    async tick(): Promise<ProgramHealthSnapshot> {
      return runOnce();
    },
    state(): { raised: Record<AlertKind, boolean> } {
      return { raised: { ...raised } };
    },
  };
}

export interface ProgramMonitorEnvConfig {
  enabled: boolean;
  intervalMs: number;
  thresholds: ProgramMonitorThresholds;
  notifier: HttpWhatsAppNotifierOptions | null;
}

/**
 * Parse the PROGRAM_MONITOR_* env vars into a typed config.
 *
 * Returned with `enabled: false` when there is no WhatsApp webhook configured
 * AND the explicit `PROGRAM_MONITOR_ENABLED` flag isn't set — same posture
 * as the synthetic monitor (skip booting the loop instead of crashing).
 */
export function readProgramMonitorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ProgramMonitorEnvConfig {
  const enabledFlag = (env.PROGRAM_MONITOR_ENABLED ?? "").trim().toLowerCase();
  const explicitlyDisabled = enabledFlag === "false" || enabledFlag === "0";

  const webhookUrl = (env.WHATSAPP_WEBHOOK_URL ?? "").trim();
  const operatorNumber = (env.WHATSAPP_OPERATOR_NUMBER ?? "").trim();
  const token = (env.WHATSAPP_WEBHOOK_TOKEN ?? "").trim();
  const fromNumber = (env.WHATSAPP_FROM_NUMBER ?? "").trim();

  const notifier =
    webhookUrl.length > 0 && operatorNumber.length > 0
      ? {
          url: webhookUrl,
          operatorNumber,
          ...(token ? { token } : {}),
          ...(fromNumber ? { fromNumber } : {}),
        }
      : null;

  const enabledByFlag = enabledFlag === "true" || enabledFlag === "1";
  const enabled = !explicitlyDisabled && (enabledByFlag || notifier !== null);

  return {
    enabled,
    intervalMs: parsePositiveInt(
      env.PROGRAM_MONITOR_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
    ),
    thresholds: {
      errorRatePct: parsePositiveFloat(
        env.PROGRAM_MONITOR_ERROR_RATE_PCT,
        DEFAULT_THRESHOLDS.errorRatePct,
      ),
      errorRateMinSamples: parsePositiveInt(
        env.PROGRAM_MONITOR_ERROR_RATE_MIN_SAMPLES,
        DEFAULT_THRESHOLDS.errorRateMinSamples,
      ),
      stuckInvoiceMs: parsePositiveInt(
        env.PROGRAM_MONITOR_STUCK_INVOICE_MS,
        DEFAULT_THRESHOLDS.stuckInvoiceMs,
      ),
      windowMs: parsePositiveInt(
        env.PROGRAM_MONITOR_WINDOW_MS,
        DEFAULT_THRESHOLDS.windowMs,
      ),
    },
    notifier,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}

function parsePositiveFloat(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}
