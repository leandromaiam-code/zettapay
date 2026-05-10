import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { HttpError } from "../lib/errors.js";
import { AGENT_HEADER } from "../lib/agent-identity.js";
import {
  AgentIdentityServiceError,
  verifyAgentProofHeader,
  type VerifiedAgent,
} from "../services/agent-identity.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `agentIdentityMiddleware` after a valid proof is verified. */
    agentIdentity?: VerifiedAgent;
  }
}

export interface AgentIdentityMiddlewareOptions {
  /** When true, missing/invalid proof short-circuits with 401/403/etc. */
  required?: boolean;
}

function asHttpError(err: AgentIdentityServiceError): HttpError {
  if (err.status === 401) return HttpError.unauthorized(err.message);
  if (err.status === 403) return new HttpError(403, "unauthorized", err.message);
  if (err.status === 404) return HttpError.notFound(err.message);
  if (err.status === 409) return HttpError.conflict(err.message);
  return HttpError.badRequest(err.message);
}

/**
 * Express middleware that consumes the `x-zettapay-agent` header, verifies
 * the cryptographic proof against the stored binding, and attaches the
 * verified identity to `req.agentIdentity`. Pass `required: true` to gate a
 * route on a verified non-spoofable agent identity.
 */
export function agentIdentityMiddleware(
  db: Db,
  options: AgentIdentityMiddlewareOptions = {},
): RequestHandler {
  const required = options.required ?? true;
  return (req: Request, _res: Response, next: NextFunction) => {
    const headerValue = req.header(AGENT_HEADER);
    if (!headerValue) {
      if (!required) {
        next();
        return;
      }
      next(
        HttpError.unauthorized(
          `"${AGENT_HEADER}" header is required — agent identity proof missing`,
        ),
      );
      return;
    }
    try {
      req.agentIdentity = verifyAgentProofHeader(db, headerValue);
      next();
    } catch (err) {
      if (err instanceof AgentIdentityServiceError) {
        next(asHttpError(err));
        return;
      }
      next(err);
    }
  };
}
