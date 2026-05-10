import { Counter, Histogram, registry } from "../lib/metrics.js";
import { logger as defaultLogger, type Logger } from "../lib/logger.js";
import { Sentry, isSentryEnabled } from "../lib/sentry.js";

/**
 * Z18.5 — synthetic monitor.
 *
 * Periodically probes the live `/pay` endpoint end-to-end so an outage is
 * detected before merchants notice. The probe is deliberately a `GET /pay`
 * (the public introspection variant) so it never creates real payments — we
 * still exercise routing, middleware, JSON serialization, and the underlying
 * runtime. A `POST /pay` variant can be enabled per environment when a test
 * merchant + idempotency key are configured.
 *
 * Alerting policy: a single slow tick is too noisy to page on (network
 * jitter, cold container starts), so we wait for `alertAfterFailures`
 * consecutive failures before raising. Once raised, the alarm clears on the
 * next successful probe — both transitions are emitted to Sentry and the
 * structured log so on-call can wire either one to PagerDuty / Opsgenie.
 */

const probeRunsTotal = registry.register(
  new Counter(
    "zettapay_synthetic_probe_runs_total",
    "Total /pay synthetic probe executions, labeled by terminal outcome.",
    ["target", "outcome"],
  ),
);

const probeLatencySeconds = registry.register(
  new Histogram(
    "zettapay_synthetic_probe_latency_seconds",
    "End-to-end latency observed by the /pay synthetic probe.",
    ["target", "outcome"],
    [0.05, 0.1, 0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
  ),
);

const probeBreachesTotal = registry.register(
  new Counter(
    "zettapay_synthetic_probe_breaches_total",
    "Number of synthetic probes that breached the latency or status thresholds.",
    ["target", "kind"],
  ),
);

export type ProbeOutcome = "ok" | "slow" | "non_2xx" | "network_error" | "timeout";

export interface SyntheticProbeResult {
  outcome: ProbeOutcome;
  ok: boolean;
  /** Wall-clock latency in milliseconds. `null` when the probe never connected. */
  latencyMs: number | null;
  status: number | null;
  startedAt: string;
  finishedAt: string;
  error: string | null;
}

export interface SyntheticMonitorOptions {
  /** Absolute URL the probe targets. Required. */
  targetUrl: string;
  /** Polling cadence in ms. Floored to 5_000 to avoid runaway probes. Default 60_000. */
  intervalMs?: number;
  /** Per-probe wallclock budget. Default 5_000. Treated as a hard timeout. */
  timeoutMs?: number;
  /** Alert when latency exceeds this many ms (and status is OK). Default 2_000. */
  latencyThresholdMs?: number;
  /** Consecutive failures required before an alert is raised. Default 2. */
  alertAfterFailures?: number;
  /**
   * When true the probe issues `POST /pay` with a synthetic idempotency key
   * and a body identifying the request as a probe. Defaults to `false` —
   * the GET introspection variant is sufficient for uptime and stays
   * side-effect-free in production.
   */
  usePost?: boolean;
  /** Body sent when {@link usePost} is true. */
  postBody?: Record<string, unknown>;
  /** Headers merged onto every probe request. */
  headers?: Record<string, string>;
  /** Test seam — defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Test seam — defaults to `Date.now`. */
  now?: () => number;
  logger?: Logger;
  /** Optional listener invoked after every probe — used by tests + status_page hook-ups. */
  onResult?: (result: SyntheticProbeResult) => void | Promise<void>;
}

export interface SyntheticMonitorHandle {
  /** Stop the polling loop and resolve once any in-flight probe finishes. */
  close(): Promise<void>;
  /** Trigger a probe immediately. Returns the probe result. */
  tick(): Promise<SyntheticProbeResult>;
  /** Snapshot of current consecutive-failure state. */
  state(): { consecutiveFailures: number; alarmRaised: boolean };
}

const MIN_INTERVAL_MS = 5_000;
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_LATENCY_THRESHOLD_MS = 2_000;
const DEFAULT_ALERT_AFTER_FAILURES = 2;

/**
 * Run a single probe. Exported so it can be invoked from a one-shot CLI or
 * a serverless cron without booting the polling loop.
 */
export async function runSyntheticProbe(
  options: SyntheticMonitorOptions,
): Promise<SyntheticProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const timeoutMs = Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const latencyThresholdMs = Math.max(
    100,
    options.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS,
  );

  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const target = options.targetUrl;

  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "zettapay-synthetic-monitor/1.0",
    ...(options.headers ?? {}),
  };

  let init: RequestInit;
  if (options.usePost) {
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = headers["idempotency-key"] ?? `synthetic-${startedAtMs}`;
    init = {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify(options.postBody ?? {}),
    };
  } else {
    init = {
      method: "GET",
      headers,
      signal: controller.signal,
    };
  }

  let status: number | null = null;
  let error: string | null = null;
  let outcome: ProbeOutcome = "ok";
  try {
    const resp = await fetchImpl(target, init);
    status = resp.status;
    // Drain the body so connection reuse and timing reflect a real client.
    // `text()` is cheap on the small JSON we expect from /pay introspection.
    try {
      await resp.text();
    } catch {
      // Body drain failures don't change the status-derived outcome.
    }
    if (resp.status >= 400) {
      outcome = "non_2xx";
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      outcome = "timeout";
      error = `timeout after ${timeoutMs}ms`;
    } else {
      outcome = "network_error";
      error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(timer);
  }

  const finishedAtMs = now();
  const latencyMs = finishedAtMs - startedAtMs;

  // A successful (2xx) but slow response is still a breach worth flagging.
  if (outcome === "ok" && latencyMs > latencyThresholdMs) {
    outcome = "slow";
  }

  const ok = outcome === "ok";
  const finalLatency = outcome === "network_error" ? null : latencyMs;

  const result: SyntheticProbeResult = {
    outcome,
    ok,
    latencyMs: finalLatency,
    status,
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    error,
  };

  probeRunsTotal.inc({ target, outcome }, 1);
  if (finalLatency !== null) {
    probeLatencySeconds.observe(
      { target, outcome },
      finalLatency / 1000,
    );
  }
  if (outcome === "slow") {
    probeBreachesTotal.inc({ target, kind: "latency" }, 1);
  } else if (outcome === "non_2xx" || outcome === "timeout" || outcome === "network_error") {
    probeBreachesTotal.inc({ target, kind: outcome }, 1);
  }

  return result;
}

export function startSyntheticMonitor(
  options: SyntheticMonitorOptions,
): SyntheticMonitorHandle {
  if (!options.targetUrl) {
    throw new Error("synthetic_monitor: targetUrl is required");
  }
  const intervalMs = Math.max(MIN_INTERVAL_MS, options.intervalMs ?? DEFAULT_INTERVAL_MS);
  const alertAfter = Math.max(1, options.alertAfterFailures ?? DEFAULT_ALERT_AFTER_FAILURES);
  const log = options.logger ?? defaultLogger;

  let running = false;
  let stopped = false;
  let lastTick: Promise<unknown> = Promise.resolve();
  let consecutiveFailures = 0;
  let alarmRaised = false;

  const onBreach = (result: SyntheticProbeResult): void => {
    if (alarmRaised) return;
    alarmRaised = true;
    const detail = {
      target: options.targetUrl,
      outcome: result.outcome,
      latencyMs: result.latencyMs,
      status: result.status,
      consecutiveFailures,
      thresholdMs: options.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS,
      error: result.error,
    };
    log.error("synthetic_monitor.alert_raised", detail);
    if (isSentryEnabled()) {
      try {
        Sentry.captureMessage(
          `synthetic_monitor: ${options.targetUrl} ${result.outcome}`,
          {
            level: "error",
            tags: {
              probe: "pay",
              outcome: result.outcome,
            },
            extra: detail,
          },
        );
      } catch {
        // Sentry is best-effort — never let it break the loop.
      }
    }
  };

  const onRecovery = (result: SyntheticProbeResult): void => {
    if (!alarmRaised) return;
    alarmRaised = false;
    log.info("synthetic_monitor.alert_cleared", {
      target: options.targetUrl,
      latencyMs: result.latencyMs,
      status: result.status,
    });
    if (isSentryEnabled()) {
      try {
        Sentry.captureMessage(
          `synthetic_monitor: ${options.targetUrl} recovered`,
          {
            level: "info",
            tags: { probe: "pay", outcome: "recovered" },
            extra: {
              target: options.targetUrl,
              latencyMs: result.latencyMs,
              status: result.status,
            },
          },
        );
      } catch {
        // best-effort
      }
    }
  };

  const runOnce = async (): Promise<SyntheticProbeResult> => {
    let result: SyntheticProbeResult;
    try {
      result = await runSyntheticProbe(options);
    } catch (err) {
      // runSyntheticProbe is built not to throw, but defend against future
      // changes — a thrown error here counts as a failure too.
      const msg = err instanceof Error ? err.message : String(err);
      result = {
        outcome: "network_error",
        ok: false,
        latencyMs: null,
        status: null,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: msg,
      };
    }

    if (result.ok) {
      consecutiveFailures = 0;
      onRecovery(result);
      log.debug?.("synthetic_monitor.tick_ok", {
        target: options.targetUrl,
        latencyMs: result.latencyMs,
        status: result.status,
      });
    } else {
      consecutiveFailures += 1;
      log.warn("synthetic_monitor.tick_failed", {
        target: options.targetUrl,
        outcome: result.outcome,
        latencyMs: result.latencyMs,
        status: result.status,
        consecutiveFailures,
        error: result.error,
      });
      if (consecutiveFailures >= alertAfter) {
        onBreach(result);
      }
    }

    if (options.onResult) {
      try {
        await options.onResult(result);
      } catch (err) {
        log.error("synthetic_monitor.on_result_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  };

  const guardedTick = async (): Promise<SyntheticProbeResult | null> => {
    if (running || stopped) return null;
    running = true;
    try {
      return await runOnce();
    } catch (err) {
      log.error("synthetic_monitor.tick_crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
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

  log.info("synthetic_monitor.started", {
    target: options.targetUrl,
    intervalMs,
    latencyThresholdMs: options.latencyThresholdMs ?? DEFAULT_LATENCY_THRESHOLD_MS,
    alertAfterFailures: alertAfter,
    method: options.usePost ? "POST" : "GET",
  });

  return {
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await lastTick;
    },
    async tick(): Promise<SyntheticProbeResult> {
      // Always run, even mid-loop — used for ad-hoc operator probes and tests.
      const result = await runOnce();
      return result;
    },
    state(): { consecutiveFailures: number; alarmRaised: boolean } {
      return { consecutiveFailures, alarmRaised };
    },
  };
}

export interface SyntheticMonitorEnvConfig {
  enabled: boolean;
  targetUrl: string | null;
  intervalMs: number;
  timeoutMs: number;
  latencyThresholdMs: number;
  alertAfterFailures: number;
  usePost: boolean;
  postBody: Record<string, unknown> | null;
}

/**
 * Parse the SYNTHETIC_MONITOR_* env vars into a typed config. Returned with
 * `enabled: false` when no target URL is set so callers can skip booting the
 * loop without crashing — same posture as Sentry/OTEL elsewhere.
 */
export function readSyntheticMonitorConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SyntheticMonitorEnvConfig {
  const rawTarget = (env.SYNTHETIC_MONITOR_TARGET_URL ?? "").trim();
  const enabledFlag = (env.SYNTHETIC_MONITOR_ENABLED ?? "").trim().toLowerCase();
  const explicitlyDisabled = enabledFlag === "false" || enabledFlag === "0";
  const targetUrl = rawTarget.length > 0 ? rawTarget : null;
  const enabled = targetUrl !== null && !explicitlyDisabled;

  const intervalMs = parsePositiveInt(env.SYNTHETIC_MONITOR_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  const timeoutMs = parsePositiveInt(env.SYNTHETIC_MONITOR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const latencyThresholdMs = parsePositiveInt(
    env.SYNTHETIC_MONITOR_LATENCY_THRESHOLD_MS,
    DEFAULT_LATENCY_THRESHOLD_MS,
  );
  const alertAfterFailures = parsePositiveInt(
    env.SYNTHETIC_MONITOR_ALERT_AFTER_FAILURES,
    DEFAULT_ALERT_AFTER_FAILURES,
  );
  const usePost = (env.SYNTHETIC_MONITOR_METHOD ?? "GET").trim().toUpperCase() === "POST";

  let postBody: Record<string, unknown> | null = null;
  const rawBody = (env.SYNTHETIC_MONITOR_POST_BODY ?? "").trim();
  if (rawBody.length > 0) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        postBody = parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid JSON — fall through with null body so the caller can log it.
    }
  }

  return {
    enabled,
    targetUrl,
    intervalMs,
    timeoutMs,
    latencyThresholdMs,
    alertAfterFailures,
    usePost,
    postBody,
  };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value;
}
