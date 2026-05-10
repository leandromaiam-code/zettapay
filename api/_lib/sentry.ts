import * as Sentry from '@sentry/node';
import type { VercelRequest, VercelResponse } from '@vercel/node';

let initialized = false;

function parseSampleRate(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) return fallback;
  return value;
}

export function initSentry(): boolean {
  if (initialized) return true;

  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  const environment =
    process.env.SENTRY_ENVIRONMENT ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    'development';

  const release =
    process.env.SENTRY_RELEASE ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    process.env.GIT_SHA;

  const tracesSampleRate = parseSampleRate(
    process.env.SENTRY_TRACES_SAMPLE_RATE,
    environment === 'production' ? 0.1 : 0,
  );

  Sentry.init({
    dsn,
    environment,
    ...(release ? { release } : {}),
    tracesSampleRate,
    sendDefaultPii: false,
  });

  initialized = true;
  return true;
}

initSentry();

type Handler = (req: VercelRequest, res: VercelResponse) => void | Promise<void>;

export function withSentry(handler: Handler): Handler {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      Sentry.captureException(err);
      try {
        await Sentry.flush(2000);
      } catch {
        // ignore flush errors
      }
      throw err;
    }
  };
}

export { Sentry };
