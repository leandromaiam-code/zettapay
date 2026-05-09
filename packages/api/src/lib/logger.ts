import { pino, type Logger as PinoLogger, type LoggerOptions } from "pino";

export const REQUEST_ID_HEADER = "x-request-id";

const level = (process.env.LOG_LEVEL ?? (process.env.NODE_ENV === "production" ? "info" : "debug")).toLowerCase();

const pretty = process.env.LOG_PRETTY === "1";

const baseOptions: LoggerOptions = {
  level,
  base: {
    service: "zettapay-api",
    env: process.env.NODE_ENV ?? "development",
    version: process.env.GIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "req.headers['x-api-key']",
      "*.privateKey",
      "*.secret",
      "*.password",
    ],
    censor: "[redacted]",
  },
};

export const baseLogger: PinoLogger = pretty
  ? pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss.l" },
      },
    })
  : pino(baseOptions);

type Meta = Record<string, unknown> | undefined;

interface LegacyLogger {
  debug: (msg: string, meta?: Meta) => void;
  info: (msg: string, meta?: Meta) => void;
  warn: (msg: string, meta?: Meta) => void;
  error: (msg: string, meta?: Meta) => void;
  child: (bindings: Record<string, unknown>) => LegacyLogger;
}

function adapt(p: PinoLogger): LegacyLogger {
  return {
    debug: (msg, meta) => p.debug(meta ?? {}, msg),
    info: (msg, meta) => p.info(meta ?? {}, msg),
    warn: (msg, meta) => p.warn(meta ?? {}, msg),
    error: (msg, meta) => p.error(meta ?? {}, msg),
    child: (bindings) => adapt(p.child(bindings)),
  };
}

export const logger = adapt(baseLogger);

export type Logger = LegacyLogger;
