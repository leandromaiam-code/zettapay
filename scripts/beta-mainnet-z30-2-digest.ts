/**
 * scripts/beta-mainnet-z30-2-digest.ts — Z30.2
 *
 * Continuous-monitoring digest for the ZettaPay mainnet beta window. Hits
 * three pre-existing endpoints — `/beta/status` (Z22.1), `/healthz`, and
 * `/metrics` — aggregates them, and emits a markdown report into
 * `reports/beta-mainnet-z30-2-<YYYY-MM-DD>.md` plus a JSON sibling for
 * machine processing.
 *
 * Why not a new endpoint? The Z22.1 + Z30.3 + Z30.4 stack already exposes
 * everything the operator needs. This script just stitches them into a
 * single, opinionated digest with the recommended next action — keeping
 * the server-side surface area frozen during the beta.
 *
 * Output sections:
 *
 *   - Beta window: day N/60, days remaining, expired flag, merchants in
 *     allowlist.
 *   - Per-merchant utilisation: cumulative USDC, cap, % utilisation,
 *     remaining, exhausted flag. Sorted by utilisation desc.
 *   - Aggregate: total TPV across cohort, % of cohort-wide cap consumed,
 *     count of exhausted merchants.
 *   - Health: API reachable, version, uptime; Prometheus alert counts
 *     scraped from /metrics.
 *   - Recommendation: a single canned string the operator pastes into the
 *     daily standup — `continue`, `investigate`, or `pause`.
 *
 * The recommendation is intentionally crude: if any beta merchant is over
 * 80% of cap OR the program-monitor alert counter is non-zero since
 * yesterday's digest, recommend `investigate`. If /healthz returns 503 or
 * the API is unreachable, recommend `pause`. Otherwise `continue`. The
 * operator overrides at will — the script is here to surface the signal,
 * not to gate human judgement.
 *
 * Invocation:
 *
 *   BETA_API_URL=https://api.zettapay.dev \
 *   BETA_REPORT_DIR=./reports \
 *   npm run beta:mainnet:digest
 *
 * Suggested cron (operator's laptop or a scheduled GitHub Action):
 *
 *   0 9 * * * cd ~/zettapay && BETA_API_URL=... npm run beta:mainnet:digest
 *
 * Environment:
 *
 *   BETA_API_URL          required, https
 *   BETA_REPORT_DIR       defaults to `./reports`
 *   BETA_INVESTIGATE_PCT  utilisation threshold for `investigate` (default 80)
 *   BETA_DIGEST_TIMEOUT_MS  per-request HTTP timeout (default 10_000)
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env, exit, stdout } from "node:process";

const HTTPS_RE = /^https:\/\//i;
const DEFAULT_REPORT_DIR = "./reports";
const DEFAULT_INVESTIGATE_PCT = 80;
const DEFAULT_TIMEOUT_MS = 10_000;

function requireEnv(name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    console.error(`Missing required env var: ${name}`);
    exit(2);
  }
  return value.trim();
}

interface MerchantUtilization {
  merchantId: string;
  cumulativeUsd: number;
  capUsd: number;
  utilizationPct: number;
  remainingUsd: number;
  exhausted: boolean;
}

interface BetaStatus {
  enabled: boolean;
  launchAt: string | null;
  endsAt: string | null;
  durationDays: number;
  daysRemaining: number | null;
  expired: boolean;
  capUsd: number;
  maxMerchants: number;
  allowlistSize: number;
  utilization: MerchantUtilization[];
  totals: {
    cumulativeUsd: number;
    capUsd: number;
    utilizationPct: number;
    merchantsExhausted: number;
  };
  generatedAt: string;
}

interface HealthSnapshot {
  reachable: boolean;
  httpStatus: number | null;
  ok: boolean;
  detail: string | null;
}

interface AlertSample {
  metric: string;
  labels: Record<string, string>;
  value: number;
}

interface DigestReport {
  generatedAt: string;
  apiUrl: string;
  beta: BetaStatus | null;
  betaError: string | null;
  health: HealthSnapshot;
  alerts: AlertSample[];
  recommendation: "continue" | "investigate" | "pause";
  recommendationReason: string;
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: T | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    const status = res.status;
    let body: T | null = null;
    try {
      body = (await res.json()) as T;
    } catch {
      body = null;
    }
    return {
      ok: res.ok,
      status,
      body,
      error: res.ok ? null : `http_${status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchText(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; text: string | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    const status = res.status;
    const text = await res.text();
    return {
      ok: res.ok,
      status,
      text,
      error: res.ok ? null : `http_${status}`,
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      text: null,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses Prometheus exposition format minimally — we only care about the
 * cumulative alert/notifier counters from program_monitor (Z30.3) so we can
 * surface "have any alerts fired since launch?" in the digest. Anything
 * that doesn't match a `metric{labels} value` line is ignored.
 */
function parseAlertCounters(text: string): AlertSample[] {
  const samples: AlertSample[] = [];
  const wanted = new Set([
    "zettapay_program_monitor_alerts_total",
    "zettapay_program_monitor_notifier_failures_total",
    "zettapay_program_monitor_ticks_total",
  ]);
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{[^}]*\})?\s+([0-9eE+.\-]+)/);
    if (!match) continue;
    const [, name, rawLabels, rawValue] = match;
    if (!name || !rawValue || !wanted.has(name)) continue;
    const value = Number(rawValue);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    if (rawLabels) {
      const inner = rawLabels.slice(1, -1);
      const re = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:\\.|[^"\\])*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(inner)) !== null) {
        if (m[1] !== undefined && m[2] !== undefined) {
          labels[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
        }
      }
    }
    samples.push({ metric: name, labels, value });
  }
  return samples;
}

function pickRecommendation(
  beta: BetaStatus | null,
  health: HealthSnapshot,
  alerts: AlertSample[],
  investigatePct: number,
): { recommendation: "continue" | "investigate" | "pause"; reason: string } {
  if (!health.reachable || !health.ok) {
    return {
      recommendation: "pause",
      reason: `API health not OK (status=${health.httpStatus ?? "unreachable"}, detail=${
        health.detail ?? "none"
      })`,
    };
  }
  if (!beta) {
    return {
      recommendation: "pause",
      reason: "Beta status endpoint returned no data — operator must investigate before any merchant transacts.",
    };
  }
  if (!beta.enabled) {
    return {
      recommendation: "pause",
      reason: "BETA_MODE_ENABLED=false — production is currently in GA mode or misconfigured.",
    };
  }
  if (beta.expired) {
    return {
      recommendation: "pause",
      reason: `Beta window expired at ${beta.endsAt ?? "(unknown)"}. Operator should graduate to GA or extend the window.`,
    };
  }

  const alertingCounters = alerts.filter(
    (a) =>
      a.metric === "zettapay_program_monitor_alerts_total" && a.value > 0,
  );
  const notifierFailures = alerts.filter(
    (a) =>
      a.metric === "zettapay_program_monitor_notifier_failures_total" &&
      a.value > 0,
  );
  if (alertingCounters.length > 0) {
    const kinds = alertingCounters
      .map((a) => `${a.labels.kind ?? "?"}=${a.value}`)
      .join(", ");
    return {
      recommendation: "investigate",
      reason: `Z30.3 program monitor has raised alerts since launch (${kinds}).`,
    };
  }
  if (notifierFailures.length > 0) {
    return {
      recommendation: "investigate",
      reason: "Z30.3 notifier failures present — alerts may not be reaching the operator.",
    };
  }

  const hot = beta.utilization.filter(
    (m) => m.utilizationPct >= investigatePct,
  );
  if (hot.length > 0) {
    return {
      recommendation: "investigate",
      reason: `${hot.length} merchant(s) at or above ${investigatePct}% of cap — consider cap upgrade or velocity review.`,
    };
  }

  return {
    recommendation: "continue",
    reason: "All beta gates green; no merchants near cap; no program monitor alerts fired.",
  };
}

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function renderMarkdown(report: DigestReport): string {
  const lines: string[] = [];
  lines.push(`# ZettaPay mainnet beta digest — ${report.generatedAt}`);
  lines.push("");
  lines.push(`- API: \`${report.apiUrl}\``);
  lines.push(`- Recommendation: **${report.recommendation.toUpperCase()}**`);
  lines.push(`- Reason: ${report.recommendationReason}`);
  lines.push("");
  lines.push("## Beta window");
  if (!report.beta) {
    lines.push(`- Status endpoint unavailable (${report.betaError ?? "unknown error"})`);
  } else {
    const b = report.beta;
    const dayN =
      b.launchAt && b.durationDays
        ? Math.max(
            0,
            Math.min(
              b.durationDays,
              Math.floor(
                (Date.parse(report.generatedAt) - Date.parse(b.launchAt)) /
                  86_400_000,
              ),
            ),
          )
        : null;
    lines.push(`- Enabled: ${b.enabled}`);
    lines.push(`- Launch: ${b.launchAt ?? "(not set)"}`);
    lines.push(`- Window: ${b.durationDays} days, ends ${b.endsAt ?? "(n/a)"}`);
    lines.push(
      `- Day: ${dayN ?? "?"}/${b.durationDays} (days remaining: ${b.daysRemaining ?? "?"}, expired: ${b.expired})`,
    );
    lines.push(`- Allowlist: ${b.allowlistSize}/${b.maxMerchants} merchants`);
    lines.push(`- Per-merchant cap: ${formatUsd(b.capUsd)}`);
  }
  lines.push("");
  lines.push("## Per-merchant utilisation");
  if (!report.beta || report.beta.utilization.length === 0) {
    lines.push("- (no merchants in allowlist)");
  } else {
    lines.push("| merchant_id | cumulative | cap | % | remaining | exhausted |");
    lines.push("|---|---:|---:|---:|---:|:---:|");
    const sorted = [...report.beta.utilization].sort(
      (a, b) => b.utilizationPct - a.utilizationPct,
    );
    for (const m of sorted) {
      lines.push(
        `| \`${m.merchantId}\` | ${formatUsd(m.cumulativeUsd)} | ${formatUsd(m.capUsd)} | ${m.utilizationPct.toFixed(1)}% | ${formatUsd(m.remainingUsd)} | ${m.exhausted ? "yes" : "no"} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Aggregate");
  if (report.beta) {
    const t = report.beta.totals;
    lines.push(`- Cohort TPV: ${formatUsd(t.cumulativeUsd)} / ${formatUsd(t.capUsd)} (${t.utilizationPct.toFixed(1)}%)`);
    lines.push(`- Exhausted merchants: ${t.merchantsExhausted}`);
  } else {
    lines.push("- (n/a)");
  }
  lines.push("");
  lines.push("## API health");
  lines.push(
    `- Reachable: ${report.health.reachable} (status=${report.health.httpStatus ?? "n/a"})`,
  );
  lines.push(`- OK: ${report.health.ok}`);
  if (report.health.detail) lines.push(`- Detail: ${report.health.detail}`);
  lines.push("");
  lines.push("## Z30.3 program-monitor counters");
  if (report.alerts.length === 0) {
    lines.push("- /metrics not reachable or no relevant samples");
  } else {
    for (const a of report.alerts) {
      const labelStr =
        Object.keys(a.labels).length === 0
          ? ""
          : ` {${Object.entries(a.labels)
              .map(([k, v]) => `${k}=${v}`)
              .join(", ")}}`;
      lines.push(`- \`${a.metric}\`${labelStr} = ${a.value}`);
    }
  }
  lines.push("");
  lines.push("---");
  lines.push("");
  lines.push("_Digest generated by `npm run beta:mainnet:digest` (Z30.2)._");
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const apiUrl = requireEnv("BETA_API_URL").replace(/\/$/, "");
  if (!HTTPS_RE.test(apiUrl)) {
    console.error("BETA_API_URL must be an https:// URL");
    exit(2);
  }
  const reportDir = resolve(env.BETA_REPORT_DIR ?? DEFAULT_REPORT_DIR);
  const investigatePct = Number(
    env.BETA_INVESTIGATE_PCT ?? DEFAULT_INVESTIGATE_PCT,
  );
  if (!Number.isFinite(investigatePct) || investigatePct <= 0) {
    console.error("BETA_INVESTIGATE_PCT must be a positive number");
    exit(2);
  }
  const timeoutMs = Number(env.BETA_DIGEST_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    console.error("BETA_DIGEST_TIMEOUT_MS must be a positive integer");
    exit(2);
  }

  const [betaRes, healthRes, metricsRes] = await Promise.all([
    fetchJson<BetaStatus>(`${apiUrl}/beta/status`, timeoutMs),
    fetchJson<{ status?: string }>(`${apiUrl}/healthz`, timeoutMs),
    fetchText(`${apiUrl}/metrics`, timeoutMs),
  ]);

  const beta = betaRes.body;
  const betaError = betaRes.ok ? null : betaRes.error ?? "unknown";

  const health: HealthSnapshot = {
    reachable: healthRes.status > 0,
    httpStatus: healthRes.status > 0 ? healthRes.status : null,
    ok: healthRes.ok,
    detail: healthRes.body?.status ?? healthRes.error,
  };

  const alerts = metricsRes.text ? parseAlertCounters(metricsRes.text) : [];

  const { recommendation, reason } = pickRecommendation(
    beta,
    health,
    alerts,
    investigatePct,
  );

  const generatedAt = new Date().toISOString();
  const report: DigestReport = {
    generatedAt,
    apiUrl,
    beta,
    betaError,
    health,
    alerts,
    recommendation,
    recommendationReason: reason,
  };

  const date = generatedAt.slice(0, 10);
  const baseName = `beta-mainnet-z30-2-${date}`;
  await mkdir(reportDir, { recursive: true });
  const markdownPath = resolve(reportDir, `${baseName}.md`);
  const jsonPath = resolve(reportDir, `${baseName}.json`);
  await writeFile(markdownPath, renderMarkdown(report), "utf8");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  stdout.write(
    [
      `digest written → ${markdownPath}`,
      `         json → ${jsonPath}`,
      `recommendation: ${recommendation.toUpperCase()} — ${reason}`,
      "",
    ].join("\n"),
  );

  if (recommendation === "pause") exit(2);
  if (recommendation === "investigate") exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  exit(1);
});
