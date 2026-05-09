import type { NextFunction, Request, RequestHandler, Response } from "express";
import { RateLimitError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { RateLimitStore } from "../lib/rate-limit-store.js";

export type RateLimitKeyResolver = (req: Request) => string | null;

export interface RateLimitOptions {
  store: RateLimitStore;
  max: number;
  windowMs: number;
  keyResolver: RateLimitKeyResolver;
  scope: string;
  skip?: (req: Request) => boolean;
  onLimit?: (req: Request, key: string) => void;
}

const TRUSTED_PROXY_HEADER = "x-forwarded-for";

export function extractApiKey(req: Request): string | null {
  const headerKey = req.header("x-api-key");
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();

  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.length > 0) return token;
  }
  return null;
}

export function extractClientIp(req: Request): string {
  const fwd = req.header(TRUSTED_PROXY_HEADER);
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

export function apiKeyResolver(req: Request): string {
  const key = extractApiKey(req);
  if (key) return `key:${key}`;
  return `ip:${extractClientIp(req)}`;
}

export function ipResolver(req: Request): string {
  return `ip:${extractClientIp(req)}`;
}

function setRateHeaders(
  res: Response,
  scope: string,
  limit: number,
  remaining: number,
  resetAtMs: number,
): void {
  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(remaining));
  res.setHeader(
    "X-RateLimit-Reset",
    String(Math.max(0, Math.ceil(resetAtMs / 1000))),
  );
  res.setHeader("X-RateLimit-Scope", scope);
}

export function rateLimit(options: RateLimitOptions): RequestHandler {
  const { store, max, windowMs, keyResolver, scope, skip, onLimit } = options;

  return async function rateLimitMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (skip?.(req)) {
      next();
      return;
    }

    let resolved: string | null;
    try {
      resolved = keyResolver(req);
    } catch (err) {
      logger.warn("rate_limit_key_resolver_failed", {
        scope,
        path: req.path,
        message: err instanceof Error ? err.message : String(err),
      });
      next();
      return;
    }
    if (!resolved) {
      next();
      return;
    }
    const key = `${scope}:${resolved}`;

    try {
      const decision = await store.hit(key, windowMs, max);
      setRateHeaders(
        res,
        scope,
        decision.limit,
        decision.remaining,
        decision.resetAtMs,
      );

      if (!decision.allowed) {
        const retryAfterSec = Math.max(
          1,
          Math.ceil((decision.resetAtMs - Date.now()) / 1000),
        );
        res.setHeader("Retry-After", String(retryAfterSec));
        onLimit?.(req, resolved);
        logger.warn("rate_limit_exceeded", {
          scope,
          path: req.path,
          method: req.method,
          identity: resolved,
          count: decision.count,
          limit: decision.limit,
          windowMs: decision.windowMs,
        });
        next(
          new RateLimitError(
            `Rate limit exceeded: ${decision.limit} requests per ${Math.round(decision.windowMs / 1000)}s`,
            retryAfterSec,
            {
              scope,
              limit: decision.limit,
              windowSec: Math.round(decision.windowMs / 1000),
              retryAfterSec,
            },
          ),
        );
        return;
      }

      next();
    } catch (err) {
      logger.error("rate_limit_store_failure", {
        scope,
        path: req.path,
        message: err instanceof Error ? err.message : String(err),
      });
      next();
    }
  };
}
