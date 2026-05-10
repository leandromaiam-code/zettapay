import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from "@opentelemetry/semantic-conventions/incubating";
import { Resource } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { logger } from "./logger.js";

export interface TracingHandle {
  /** Drain pending spans and shut the SDK down. Safe to call from a shutdown hook. */
  shutdown(): Promise<void>;
  /** True iff the SDK actually started — false when tracing is disabled. */
  readonly enabled: boolean;
}

const DISABLED: TracingHandle = {
  enabled: false,
  async shutdown() {
    /* no-op */
  },
};

/**
 * Boots OpenTelemetry tracing for the API + worker processes.
 *
 * Distributed traces follow the payment flow end-to-end:
 *   incoming HTTP /pay  →  Solana RPC transferChecked  →  webhook dispatch  →  done
 *
 * Each hop is a span; W3C `traceparent` headers are auto-propagated by the
 * HTTP instrumentation, so a merchant receiving the webhook can join the same
 * trace if their server speaks OpenTelemetry too.
 *
 * Configuration is env-var driven (OTel standard envs):
 *   OTEL_SDK_DISABLED=true          → fully disable tracing
 *   OTEL_TRACES_EXPORTER=console    → log spans to stdout (dev)
 *   OTEL_EXPORTER_OTLP_ENDPOINT=... → OTLP/HTTP collector URL
 *   OTEL_SERVICE_NAME=...           → defaults to `zettapay-api` / `zettapay-worker`
 *
 * Tracing must never break the service: any init failure is swallowed and
 * logged, and the returned handle no-ops on shutdown.
 */
export function initTracing(serviceName: string): TracingHandle {
  if (process.env.OTEL_SDK_DISABLED === "true") {
    logger.info("tracing.disabled", { reason: "OTEL_SDK_DISABLED" });
    return DISABLED;
  }

  if (process.env.OTEL_LOG_LEVEL) {
    diag.setLogger(
      new DiagConsoleLogger(),
      parseDiagLevel(process.env.OTEL_LOG_LEVEL),
    );
  }

  const exporter = resolveExporter();
  if (!exporter) {
    logger.info("tracing.disabled", { reason: "no_exporter_configured" });
    return DISABLED;
  }

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? serviceName,
    [ATTR_SERVICE_VERSION]:
      process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? "0.0.0",
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      process.env.NODE_ENV ?? "development",
  });

  const spanProcessor: SpanProcessor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 2048,
    maxExportBatchSize: 512,
    scheduledDelayMillis: 5_000,
    exportTimeoutMillis: 30_000,
  });

  // Auto-instrument http/express/ioredis/fetch — covers the inbound request
  // span, the webhook outbound HTTP, and Solana RPC calls (web3.js uses fetch).
  // Heavy instrumentations we don't need are disabled to keep startup quick.
  const instrumentations = getNodeAutoInstrumentations({
    "@opentelemetry/instrumentation-fs": { enabled: false },
    "@opentelemetry/instrumentation-dns": { enabled: false },
    "@opentelemetry/instrumentation-net": { enabled: false },
    "@opentelemetry/instrumentation-http": {
      ignoreIncomingRequestHook: (req) => {
        const url = req.url ?? "";
        return url === "/healthz" || url === "/";
      },
    },
  });

  const sdk = new NodeSDK({
    resource,
    spanProcessors: [spanProcessor],
    instrumentations,
  });

  try {
    sdk.start();
    logger.info("tracing.started", {
      service: serviceName,
      exporter: describeExporter(),
    });
  } catch (err) {
    logger.error("tracing.start_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return DISABLED;
  }

  return {
    enabled: true,
    async shutdown() {
      try {
        await sdk.shutdown();
      } catch (err) {
        logger.warn("tracing.shutdown_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}

function resolveExporter(): SpanExporter | null {
  const exporterEnv = (process.env.OTEL_TRACES_EXPORTER ?? "").toLowerCase();
  if (exporterEnv === "none") return null;
  if (exporterEnv === "console") return new ConsoleSpanExporter();

  const otlpEndpoint =
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (otlpEndpoint || exporterEnv === "otlp") {
    return new OTLPTraceExporter();
  }

  // No exporter configured → tracing is effectively a no-op. We return null
  // so callers can short-circuit instead of running spans into the void.
  return null;
}

function describeExporter(): string {
  const exporterEnv = (process.env.OTEL_TRACES_EXPORTER ?? "").toLowerCase();
  if (exporterEnv === "console") return "console";
  if (
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
    exporterEnv === "otlp"
  ) {
    return "otlp/http";
  }
  return "none";
}

function parseDiagLevel(raw: string): DiagLogLevel {
  switch (raw.toLowerCase()) {
    case "verbose":
      return DiagLogLevel.VERBOSE;
    case "debug":
      return DiagLogLevel.DEBUG;
    case "info":
      return DiagLogLevel.INFO;
    case "warn":
      return DiagLogLevel.WARN;
    case "error":
      return DiagLogLevel.ERROR;
    case "none":
      return DiagLogLevel.NONE;
    default:
      return DiagLogLevel.INFO;
  }
}
