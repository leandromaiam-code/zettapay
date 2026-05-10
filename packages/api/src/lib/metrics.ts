/**
 * Lightweight Prometheus metrics registry. Avoids pulling in prom-client so
 * the build stays slim — the Prometheus text exposition format is stable and
 * narrow enough that a hand-rolled implementation is safer than another
 * transitive dependency surface.
 *
 * Exposed via GET /metrics for Prometheus scrape; rendered alongside the
 * static infra gauges in routes/health.ts.
 */

type LabelValues = Record<string, string>;

const HISTOGRAM_DEFAULT_BUCKETS_SECONDS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: LabelValues): string {
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const parts = keys.map((k) => `${k}="${escapeLabelValue(labels[k] ?? "")}"`);
  return `{${parts.join(",")}}`;
}

function labelsKey(labels: LabelValues): string {
  return formatLabels(labels);
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    if (value === Number.POSITIVE_INFINITY) return "+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";
    return "NaN";
  }
  if (Number.isInteger(value)) return value.toString();
  return value.toString();
}

interface Renderable {
  render(): string;
}

export class Counter implements Renderable {
  private readonly values = new Map<string, { labels: LabelValues; value: number }>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: readonly string[] = [],
  ) {}

  inc(labels: LabelValues = {}, value = 1): void {
    if (value < 0) throw new Error(`Counter ${this.name} cannot decrease`);
    const safeLabels = this.normalizeLabels(labels);
    const key = labelsKey(safeLabels);
    const current = this.values.get(key);
    if (current) {
      current.value += value;
    } else {
      this.values.set(key, { labels: safeLabels, value });
    }
  }

  reset(): void {
    this.values.clear();
  }

  private normalizeLabels(labels: LabelValues): LabelValues {
    if (this.labelNames.length === 0) return {};
    const out: LabelValues = {};
    for (const name of this.labelNames) {
      out[name] = labels[name] ?? "";
    }
    return out;
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} counter`,
    ];
    if (this.values.size === 0) {
      // Emit a zero-valued sample so the metric is always present in scrapes,
      // making Grafana panels render cleanly on a freshly-booted process.
      lines.push(`${this.name} 0`);
    } else {
      for (const { labels, value } of this.values.values()) {
        lines.push(`${this.name}${formatLabels(labels)} ${formatNumber(value)}`);
      }
    }
    return lines.join("\n");
  }
}

interface HistogramBucketState {
  labels: LabelValues;
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class Histogram implements Renderable {
  private readonly buckets: readonly number[];
  private readonly series = new Map<string, HistogramBucketState>();

  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly labelNames: readonly string[] = [],
    buckets: readonly number[] = HISTOGRAM_DEFAULT_BUCKETS_SECONDS,
  ) {
    if (buckets.length === 0) {
      throw new Error(`Histogram ${name} requires at least one bucket`);
    }
    const sorted = [...buckets].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1]) {
        throw new Error(`Histogram ${name} has duplicate bucket boundary`);
      }
    }
    this.buckets = sorted;
  }

  observe(labels: LabelValues, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const safeLabels = this.normalizeLabels(labels);
    const key = labelsKey(safeLabels);
    let state = this.series.get(key);
    if (!state) {
      state = {
        labels: safeLabels,
        bucketCounts: new Array(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      };
      this.series.set(key, state);
    }
    state.count += 1;
    state.sum += value;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= (this.buckets[i] ?? Number.POSITIVE_INFINITY)) {
        state.bucketCounts[i] = (state.bucketCounts[i] ?? 0) + 1;
      }
    }
  }

  reset(): void {
    this.series.clear();
  }

  private normalizeLabels(labels: LabelValues): LabelValues {
    if (this.labelNames.length === 0) return {};
    const out: LabelValues = {};
    for (const name of this.labelNames) {
      out[name] = labels[name] ?? "";
    }
    return out;
  }

  render(): string {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} histogram`,
    ];
    if (this.series.size === 0) {
      const empty: LabelValues = {};
      for (const b of this.buckets) {
        lines.push(`${this.name}_bucket${formatLabels({ ...empty, le: formatBucketBoundary(b) })} 0`);
      }
      lines.push(`${this.name}_bucket${formatLabels({ ...empty, le: "+Inf" })} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines.join("\n");
    }
    for (const state of this.series.values()) {
      for (let i = 0; i < this.buckets.length; i++) {
        const count = state.bucketCounts[i] ?? 0;
        lines.push(
          `${this.name}_bucket${formatLabels({ ...state.labels, le: formatBucketBoundary(this.buckets[i] ?? 0) })} ${formatNumber(count)}`,
        );
      }
      lines.push(
        `${this.name}_bucket${formatLabels({ ...state.labels, le: "+Inf" })} ${formatNumber(state.count)}`,
      );
      lines.push(`${this.name}_sum${formatLabels(state.labels)} ${formatNumber(state.sum)}`);
      lines.push(`${this.name}_count${formatLabels(state.labels)} ${formatNumber(state.count)}`);
    }
    return lines.join("\n");
  }
}

function formatBucketBoundary(b: number): string {
  if (Number.isInteger(b)) return `${b}`;
  return b.toString();
}

export class Registry {
  private readonly metrics = new Map<string, Renderable>();

  register<T extends Renderable & { name: string }>(metric: T): T {
    if (this.metrics.has(metric.name)) {
      throw new Error(`Metric ${metric.name} already registered`);
    }
    this.metrics.set(metric.name, metric);
    return metric;
  }

  /** Reset all registered metrics — used by tests to isolate state. */
  resetForTest(): void {
    for (const metric of this.metrics.values()) {
      const m = metric as { reset?: () => void };
      m.reset?.();
    }
  }

  render(): string {
    const sorted = [...this.metrics.values()];
    return sorted.map((m) => m.render()).join("\n") + "\n";
  }
}

export const registry = new Registry();

// HTTP request observability — drives the Grafana p50/p95/p99 + RPS + error
// rate panels. Cardinality is bounded by `route` (express path templates, not
// raw URLs) and the small enum of method/status_class.
export const httpRequestsTotal = registry.register(
  new Counter(
    "zettapay_http_requests_total",
    "Total HTTP requests handled by the API, labeled by route + method + status class.",
    ["method", "route", "status", "status_class"],
  ),
);

export const httpRequestDurationSeconds = registry.register(
  new Histogram(
    "zettapay_http_request_duration_seconds",
    "End-to-end HTTP request latency in seconds.",
    ["method", "route"],
  ),
);

// Payment volume — the business KPI panel. `status` separates completed vs
// failed so dashboards can plot acceptance rate alongside raw volume.
export const paymentsTotal = registry.register(
  new Counter(
    "zettapay_payments_total",
    "Total payments processed by terminal status.",
    ["status", "currency"],
  ),
);

export const paymentVolumeUsdcTotal = registry.register(
  new Counter(
    "zettapay_payment_volume_usdc_total",
    "Cumulative USDC payment volume by terminal status.",
    ["status", "currency"],
  ),
);

export function recordPaymentOutcome(
  status: "completed" | "failed",
  currency: string,
  amountUsdc: number,
): void {
  paymentsTotal.inc({ status, currency }, 1);
  if (Number.isFinite(amountUsdc) && amountUsdc > 0) {
    paymentVolumeUsdcTotal.inc({ status, currency }, amountUsdc);
  }
}
