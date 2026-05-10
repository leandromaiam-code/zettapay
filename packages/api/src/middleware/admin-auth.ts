import type { NextFunction, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../lib/errors.js";

const ACTOR_HEADER = "x-admin-actor";
const MIN_KEY_LENGTH = 24;

interface AdminAuthLocals {
  adminActor: string;
}

declare module "express-serve-static-core" {
  interface Request {
    admin?: AdminAuthLocals;
  }
}

export interface AdminAuthOptions {
  /** Shared admin key. When undefined, blank, or shorter than 24 chars,
   *  the route refuses every request with config_error — keeps mainnet safe
   *  from accidental open access. */
  adminKey: string | null | undefined;
  /**
   * Name of the env var that should be set, surfaced in the config_error so
   * operators know which key is missing without grepping the codebase.
   */
  envVarName?: string;
}

function extractCredential(req: Request): string | null {
  const headerKey = req.header("x-api-key");
  if (headerKey && headerKey.trim().length > 0) return headerKey.trim();
  const auth = req.header("authorization");
  if (auth && /^bearer\s+/i.test(auth)) {
    const token = auth.replace(/^bearer\s+/i, "").trim();
    if (token.length > 0) return token;
  }
  return null;
}

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function adminAuth(options: AdminAuthOptions): RequestHandler {
  const expected = (options.adminKey ?? "").trim();
  const envName = options.envVarName ?? "ZETTAPAY_ADMIN_KEY";
  if (expected.length < MIN_KEY_LENGTH) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next(HttpError.config(`${envName} is not configured (min 24 chars)`));
    };
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = extractCredential(req);
    if (!presented || !safeEquals(presented, expected)) {
      next(HttpError.unauthorized("admin key invalid or missing"));
      return;
    }
    const actorHeader = req.header(ACTOR_HEADER);
    const actor =
      actorHeader && actorHeader.trim().length > 0
        ? actorHeader.trim().slice(0, 128)
        : "admin";
    req.admin = { adminActor: actor };
    next();
  };
}
