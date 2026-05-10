import type { NextFunction, Request, RequestHandler, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../lib/errors.js";

const ACTOR_HEADER = "x-treasury-actor";
const MIN_KEY_LENGTH = 24;

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

export interface TreasuryAuthOptions {
  /** Shared admin key. When undefined or empty, the route refuses all requests. */
  adminKey: string | null | undefined;
}

interface TreasuryAuthLocals {
  treasuryActor: string;
}

declare module "express-serve-static-core" {
  interface Request {
    treasury?: TreasuryAuthLocals;
  }
}

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function treasuryAuth(options: TreasuryAuthOptions): RequestHandler {
  const expected = (options.adminKey ?? "").trim();
  if (expected.length < MIN_KEY_LENGTH) {
    return (_req: Request, _res: Response, next: NextFunction) => {
      next(
        HttpError.config(
          "ZETTAPAY_TREASURY_ADMIN_KEY is not configured (min 24 chars)",
        ),
      );
    };
  }
  return (req: Request, _res: Response, next: NextFunction) => {
    const presented = extractCredential(req);
    if (!presented || !safeEquals(presented, expected)) {
      next(HttpError.unauthorized("treasury admin key invalid or missing"));
      return;
    }
    const actorHeader = req.header(ACTOR_HEADER);
    const actor =
      actorHeader && actorHeader.trim().length > 0
        ? actorHeader.trim().slice(0, 128)
        : "treasury-admin";
    req.treasury = { treasuryActor: actor };
    next();
  };
}
