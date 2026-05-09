import type { ErrorRequestHandler, Request, Response, NextFunction } from "express";
import { HttpError } from "../lib/errors.js";

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    });
    return;
  }
  const message = err instanceof Error ? err.message : "internal error";
  if (process.env.NODE_ENV !== "test") {
    console.error("[zettapay-api] unhandled error", err);
  }
  res.status(500).json({
    error: { code: "internal_error", message },
  });
};
