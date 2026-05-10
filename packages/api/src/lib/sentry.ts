import * as Sentry from "@sentry/node";
import { logger } from "./logger.js";

let initialized = false;

export interface InitSentryOptions {
  /** Override DSN (defaults to process.env.SENTRY_DSN) */
  dsn?: string;
  /** Override environment label (defaults to SENTRY_ENVIRONMENT or NODE_ENV) */
  environment?: string;
  /** Override release identifier (defaults to SENTRY_RELEASE or VERCEL_GIT_COMMIT_SHA) */
  release?: string;
}

function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

export function resolveRelease(): string | undefined {
  return (
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_SHA ??
    undefined
  );
}

export function isSentryEnabled(): boolean {
  return Boolean(process.env.SENTRY_DSN);
}

export function initSentry(options: InitSentryOptions = {}): boolean {
  if (initialized) return true;

  const dsn = options.dsn ?? process.env.SENTRY_DSN;
  if (!dsn) {
    return false;
  }

  const environment =
    options.environment ??
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development";

  const release = options.release ?? resolveRelease();

  const tracesSampleRate = parseSampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE,
    environment === "production" ? 0.1 : 0,
  );

  const profilesSampleRate = parseSampleRate(
    process.env.SENTRY_PROFILES_SAMPLE_RATE,
    0,
  );

  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate,
    profilesSampleRate,
    sendDefaultPii: false,
  });

  initialized = true;
  logger.info("sentry.initialized", {
    environment,
    release: release ?? null,
    tracesSampleRate,
  });
  return true;
}

export { Sentry };
