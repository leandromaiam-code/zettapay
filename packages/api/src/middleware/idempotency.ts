import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database as Db } from "better-sqlite3";
import {
  findIdempotencyRecord,
  insertIdempotencyRecord,
} from "../db/idempotency.js";
import { HttpError } from "../lib/errors.js";

const HEADER = "idempotency-key";
const REPLAY_HEADER = "idempotent-replayed";
const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotencyOptions {
  scope: string;
  required?: boolean;
}

/**
 * Caches successful (2xx) responses keyed by `(scope, Idempotency-Key header)`.
 * Replays the cached body when the same key is presented again with the same
 * request body; rejects with 409 when the key is reused with a different body.
 *
 * The header is optional by default — clients that omit it get the legacy
 * non-deduped behavior. Pass `required: true` to enforce its presence.
 */
export function idempotency(db: Db, options: IdempotencyOptions): RequestHandler {
  const { scope, required = false } = options;
  return (req: Request, res: Response, next: NextFunction): void => {
    const headerValue = req.header(HEADER);

    if (!headerValue) {
      if (required) {
        next(
          HttpError.badRequest(
            `"Idempotency-Key" header is required for ${scope}`,
          ),
        );
        return;
      }
      next();
      return;
    }

    const key = headerValue.trim();
    if (!KEY_PATTERN.test(key)) {
      next(
        HttpError.badRequest(
          '"Idempotency-Key" must be 8-128 chars from [A-Za-z0-9_-]',
        ),
      );
      return;
    }

    const requestHash = hashRequestBody(req.body);

    const cached = findIdempotencyRecord(db, scope, key);
    if (cached) {
      if (cached.requestHash !== requestHash) {
        next(
          HttpError.conflict(
            '"Idempotency-Key" reused with a different request body',
          ),
        );
        return;
      }
      const body = JSON.parse(cached.responseBody) as unknown;
      res
        .status(cached.responseStatus)
        .setHeader(REPLAY_HEADER, "true")
        .json(body);
      return;
    }

    const originalJson = res.json.bind(res);
    res.json = function patchedJson(body: unknown): Response {
      const status = res.statusCode;
      if (status >= 200 && status < 300) {
        insertIdempotencyRecord(db, {
          scope,
          key,
          requestHash,
          responseStatus: status,
          responseBody: JSON.stringify(body ?? null),
        });
      }
      return originalJson(body);
    };
    next();
  };
}

function hashRequestBody(body: unknown): string {
  const canonical = canonicalize(body);
  return createHash("sha256").update(canonical).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const entries = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`);
  return `{${entries.join(",")}}`;
}
