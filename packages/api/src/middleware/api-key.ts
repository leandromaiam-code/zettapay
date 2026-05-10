import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { findApiKeyBySecretHash, type ApiKey } from "../db/api_keys.js";
import { findMerchantById, type Merchant } from "../db/merchants.js";
import { hashSecret, isSecretKey } from "../lib/api-keys.js";
import { HttpError } from "../lib/errors.js";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKey;
      merchant?: Merchant;
    }
  }
}

/** Pull a Bearer token off the request. Accepts either:
 *   Authorization: Bearer sk_live_…
 *   x-api-key: sk_live_…
 * Mirrors the resolver used by the rate limiter so credential surfaces stay
 * consistent across the API. */
export function extractBearerToken(req: Request): string | null {
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.length > 0) return token;
  }
  const headerKey = req.header("x-api-key");
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
  return null;
}

/**
 * Authenticate a request via a `sk_live_*` bearer token.
 *
 * Premise IX/V: scopes the request to the owning merchant before any business
 * logic runs. The Postgres mirror uses an RLS policy keyed on `auth.uid()` —
 * here on SQLite we attach `req.merchant` so route handlers enforce the same
 * tenant boundary at the application layer.
 */
export function requireApiKey(db: Db): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const token = extractBearerToken(req);
    if (!token) {
      next(
        HttpError.unauthorized(
          'Missing API key — provide "Authorization: Bearer sk_live_…"',
        ),
      );
      return;
    }
    if (!isSecretKey(token)) {
      next(HttpError.unauthorized("Invalid API key format"));
      return;
    }

    const apiKey = findApiKeyBySecretHash(db, hashSecret(token));
    if (!apiKey) {
      next(HttpError.unauthorized("Invalid API key"));
      return;
    }
    if (apiKey.revokedAt !== null) {
      next(HttpError.unauthorized("API key has been revoked"));
      return;
    }

    const merchant = findMerchantById(db, apiKey.merchantId);
    if (!merchant) {
      next(HttpError.unauthorized("API key references unknown merchant"));
      return;
    }

    req.apiKey = apiKey;
    req.merchant = merchant;
    next();
  };
}
