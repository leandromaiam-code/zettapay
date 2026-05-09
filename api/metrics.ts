import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const PROM_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function fmtLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const inner = entries.map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');
  return `{${inner}}`;
}

type Metric = {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Array<{ labels?: Record<string, string>; value: number }>;
};

function renderMetric(metric: Metric): string {
  const lines: string[] = [
    `# HELP ${metric.name} ${metric.help}`,
    `# TYPE ${metric.name} ${metric.type}`,
  ];
  for (const sample of metric.samples) {
    const labels = sample.labels ? fmtLabels(sample.labels) : '';
    lines.push(`${metric.name}${labels} ${sample.value}`);
  }
  return lines.join('\n');
}

function buildMetrics(): string {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'dev';
  const region = process.env.VERCEL_REGION ?? 'unknown';
  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? 'unknown';
  const rpcConfigured = (process.env.SOLANA_RPC_URL ?? '').trim().length > 0 ? 1 : 0;
  const moonpayConfigured = (process.env.MOONPAY_WEBHOOK_SECRET ?? '').trim().length > 0 ? 1 : 0;
  const merchantWebhookConfigured = (process.env.MERCHANT_WEBHOOK_URL ?? '').trim().length > 0 ? 1 : 0;

  const metrics: Metric[] = [
    {
      name: 'zettapay_build_info',
      help: 'Build metadata exposed as a constant gauge with value 1.',
      type: 'gauge',
      samples: [
        {
          labels: { service: SERVICE, version, runtime: 'vercel-serverless', region, env },
          value: 1,
        },
      ],
    },
    {
      name: 'zettapay_solana_rpc_configured',
      help: 'Whether the SOLANA_RPC_URL environment variable is configured (1) or not (0).',
      type: 'gauge',
      samples: [{ value: rpcConfigured }],
    },
    {
      name: 'zettapay_moonpay_webhook_configured',
      help: 'Whether the MoonPay webhook secret is configured (1) or not (0).',
      type: 'gauge',
      samples: [{ value: moonpayConfigured }],
    },
    {
      name: 'zettapay_merchant_webhook_configured',
      help: 'Whether the merchant outbound webhook URL is configured (1) or not (0).',
      type: 'gauge',
      samples: [{ value: merchantWebhookConfigured }],
    },
    {
      name: 'process_uptime_seconds',
      help: 'Number of seconds since the Node.js process started.',
      type: 'gauge',
      samples: [{ value: process.uptime() }],
    },
    {
      name: 'process_resident_memory_bytes',
      help: 'Resident set size of the Node.js process in bytes.',
      type: 'gauge',
      samples: [{ value: mem.rss }],
    },
    {
      name: 'nodejs_heap_size_used_bytes',
      help: 'V8 heap size used in bytes.',
      type: 'gauge',
      samples: [{ value: mem.heapUsed }],
    },
    {
      name: 'nodejs_heap_size_total_bytes',
      help: 'V8 heap size total in bytes.',
      type: 'gauge',
      samples: [{ value: mem.heapTotal }],
    },
    {
      name: 'nodejs_external_memory_bytes',
      help: 'Memory used by C++ objects bound to JavaScript objects in bytes.',
      type: 'gauge',
      samples: [{ value: mem.external }],
    },
    {
      name: 'process_cpu_user_seconds_total',
      help: 'Total user CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: cpu.user / 1_000_000 }],
    },
    {
      name: 'process_cpu_system_seconds_total',
      help: 'Total system CPU time spent in seconds.',
      type: 'counter',
      samples: [{ value: cpu.system / 1_000_000 }],
    },
  ];

  return metrics.map(renderMetric).join('\n') + '\n';
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  res.setHeader('Content-Type', PROM_CONTENT_TYPE);
  res.status(200).send(buildMetrics());
}

export { buildMetrics };
