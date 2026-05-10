import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  type BetaLaunchConfig,
  loadBetaConfig,
} from "../beta/config.js";
import { betaStatusSnapshot } from "../beta/monitoring.js";

const SERVICE = "zettapay-api";
const READY_TIMEOUT_MS = 2_500;
const PROM_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

type CheckResult = { ok: boolean; detail?: string; latencyMs?: number };

async function checkSolanaRpc(url: string): Promise<CheckResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), READY_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth" }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      return { ok: false, detail: `http_${response.status}`, latencyMs };
    }
    const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) {
      return { ok: false, detail: body.error.message ?? "rpc_error", latencyMs };
    }
    return { ok: body.result === "ok", detail: String(body.result ?? "unknown"), latencyMs };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.name : "unknown_error",
      latencyMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function fmtLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return "";
  return `{${entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(",")}}`;
}

type Metric = {
  name: string;
  help: string;
  type: "gauge" | "counter";
  samples: Array<{ labels?: Record<string, string>; value: number }>;
};

function renderMetric(metric: Metric): string {
  const lines = [`# HELP ${metric.name} ${metric.help}`, `# TYPE ${metric.name} ${metric.type}`];
  for (const sample of metric.samples) {
    const labels = sample.labels ? fmtLabels(sample.labels) : "";
    lines.push(`${metric.name}${labels} ${sample.value}`);
  }
  return lines.join("\n");
}

export interface PrometheusContext {
  db?: Db;
  betaConfig?: BetaLaunchConfig;
}

export function buildPrometheusMetrics(ctx: PrometheusContext = {}): string {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";
  const env = process.env.NODE_ENV ?? "unknown";
  const rpcConfigured = (process.env.SOLANA_RPC_URL ?? "").trim().length > 0 ? 1 : 0;
  const moonpayConfigured = (process.env.MOONPAY_WEBHOOK_SECRET ?? "").trim().length > 0 ? 1 : 0;
  const merchantWebhookConfigured = (process.env.MERCHANT_WEBHOOK_URL ?? "").trim().length > 0 ? 1 : 0;

  const metrics: Metric[] = [
    {
      name: "zettapay_build_info",
      help: "Build metadata exposed as a constant gauge with value 1.",
      type: "gauge",
      samples: [{ labels: { service: SERVICE, version, env }, value: 1 }],
    },
    {
      name: "zettapay_solana_rpc_configured",
      help: "Whether SOLANA_RPC_URL is configured (1) or not (0).",
      type: "gauge",
      samples: [{ value: rpcConfigured }],
    },
    {
      name: "zettapay_moonpay_webhook_configured",
      help: "Whether the MoonPay webhook secret is configured (1) or not (0).",
      type: "gauge",
      samples: [{ value: moonpayConfigured }],
    },
    {
      name: "zettapay_merchant_webhook_configured",
      help: "Whether the merchant outbound webhook URL is configured (1) or not (0).",
      type: "gauge",
      samples: [{ value: merchantWebhookConfigured }],
    },
    {
      name: "process_uptime_seconds",
      help: "Number of seconds since the Node.js process started.",
      type: "gauge",
      samples: [{ value: process.uptime() }],
    },
    {
      name: "process_resident_memory_bytes",
      help: "Resident set size of the Node.js process in bytes.",
      type: "gauge",
      samples: [{ value: mem.rss }],
    },
    {
      name: "nodejs_heap_size_used_bytes",
      help: "V8 heap size used in bytes.",
      type: "gauge",
      samples: [{ value: mem.heapUsed }],
    },
    {
      name: "nodejs_heap_size_total_bytes",
      help: "V8 heap size total in bytes.",
      type: "gauge",
      samples: [{ value: mem.heapTotal }],
    },
    {
      name: "nodejs_external_memory_bytes",
      help: "Memory used by C++ objects bound to JavaScript objects in bytes.",
      type: "gauge",
      samples: [{ value: mem.external }],
    },
    {
      name: "process_cpu_user_seconds_total",
      help: "Total user CPU time spent in seconds.",
      type: "counter",
      samples: [{ value: cpu.user / 1_000_000 }],
    },
    {
      name: "process_cpu_system_seconds_total",
      help: "Total system CPU time spent in seconds.",
      type: "counter",
      samples: [{ value: cpu.system / 1_000_000 }],
    },
  ];

  if (ctx.db && ctx.betaConfig) {
    const snapshot = betaStatusSnapshot(ctx.db, ctx.betaConfig);
    metrics.push(
      {
        name: "zettapay_beta_enabled",
        help: "Whether the Z22.1 beta launch protocol is currently enforcing gates (1) or off (0).",
        type: "gauge",
        samples: [{ value: snapshot.enabled ? 1 : 0 }],
      },
      {
        name: "zettapay_beta_allowlist_size",
        help: "Number of merchants curated into the beta cohort.",
        type: "gauge",
        samples: [{ value: snapshot.allowlistSize }],
      },
      {
        name: "zettapay_beta_max_merchants",
        help: "Hard ceiling on the beta cohort size.",
        type: "gauge",
        samples: [{ value: snapshot.maxMerchants }],
      },
      {
        name: "zettapay_beta_cap_usdc",
        help: "Per-merchant beta spend cap in USDC.",
        type: "gauge",
        samples: [{ value: snapshot.capUsd }],
      },
      {
        name: "zettapay_beta_days_remaining",
        help: "Days remaining in the beta window. Reports 0 once expired or unset.",
        type: "gauge",
        samples: [{ value: snapshot.daysRemaining ?? 0 }],
      },
      {
        name: "zettapay_beta_expired",
        help: "Whether the beta launch window has elapsed (1) or not (0).",
        type: "gauge",
        samples: [{ value: snapshot.expired ? 1 : 0 }],
      },
      {
        name: "zettapay_beta_merchants_exhausted",
        help: "Count of beta merchants that have hit the per-merchant cap.",
        type: "gauge",
        samples: [{ value: snapshot.totals.merchantsExhausted }],
      },
      {
        name: "zettapay_beta_cohort_cumulative_usdc",
        help: "Sum of non-failed payment volume across the beta cohort since launch.",
        type: "gauge",
        samples: [{ value: snapshot.totals.cumulativeUsd }],
      },
      {
        name: "zettapay_beta_merchant_cumulative_usdc",
        help: "Per-merchant non-failed payment volume since beta launch.",
        type: "gauge",
        samples: snapshot.utilization.map((m) => ({
          labels: { merchant_id: m.merchantId },
          value: m.cumulativeUsd,
        })),
      },
      {
        name: "zettapay_beta_merchant_utilization_pct",
        help: "Per-merchant beta cap utilization percentage (0-100).",
        type: "gauge",
        samples: snapshot.utilization.map((m) => ({
          labels: { merchant_id: m.merchantId },
          value: m.utilizationPct,
        })),
      },
    );
  }

  return metrics.map(renderMetric).join("\n") + "\n";
}

export interface HealthRouterOptions {
  db?: Db;
  betaConfig?: BetaLaunchConfig;
}

export function healthRouter(options: HealthRouterOptions = {}): Router {
  const router = Router();
  const ctx: PrometheusContext = {
    ...(options.db ? { db: options.db } : {}),
    betaConfig: options.betaConfig ?? loadBetaConfig(),
  };

  router.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      service: SERVICE,
      uptimeSec: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  router.get("/ready", async (_req, res) => {
    const rpcUrl = process.env.SOLANA_RPC_URL?.trim();
    const checks: Record<string, CheckResult> = {};
    if (rpcUrl && rpcUrl.length > 0) {
      checks.solanaRpc = await checkSolanaRpc(rpcUrl);
    } else {
      checks.solanaRpc = { ok: false, detail: "not_configured" };
    }
    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "ready" : "unready",
      service: SERVICE,
      timestamp: new Date().toISOString(),
      checks,
    });
  });

  router.get("/metrics", (_req, res) => {
    res.setHeader("Content-Type", PROM_CONTENT_TYPE);
    res.status(200).send(buildPrometheusMetrics(ctx));
  });

  return router;
}
