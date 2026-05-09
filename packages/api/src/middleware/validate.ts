import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from "zod";
import { ValidationError } from "../lib/errors.js";

export type RequestSection = "body" | "query" | "params" | "headers";

export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
  headers?: ZodTypeAny;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      validated?: {
        body?: unknown;
        query?: unknown;
        params?: unknown;
        headers?: unknown;
      };
    }
  }
}

function flatten(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    code: issue.code,
    message: issue.message,
  }));
}

export function validate<S extends ValidateSchemas>(schemas: S): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const validated: Record<RequestSection, unknown> = {
      body: undefined,
      query: undefined,
      params: undefined,
      headers: undefined,
    };

    for (const key of ["body", "query", "params", "headers"] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key]);
      if (!result.success) {
        return next(
          new ValidationError(
            `Invalid request ${key}`,
            { section: key, issues: flatten(result.error) },
          ),
        );
      }
      validated[key] = result.data;
      if (key === "body" || key === "params") {
        (req as unknown as Record<string, unknown>)[key] = result.data;
      }
    }

    req.validated = validated;
    return next();
  };
}

export type Validated<S extends ZodTypeAny> = ZodInfer<S>;
