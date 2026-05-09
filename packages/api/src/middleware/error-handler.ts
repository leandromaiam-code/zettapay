import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (err instanceof HttpError) {
    if (err.status >= 500) {
      logger.error("http_error", {
        status: err.status,
        code: err.code,
        path: req.path,
        message: err.message,
        details: err.details,
      });
    } else {
      logger.warn("http_error", {
        status: err.status,
        code: err.code,
        path: req.path,
        message: err.message,
      });
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details ?? null },
    });
    return;
  }

  const e = err as Error;
  logger.error("unhandled_error", {
    path: req.path,
    message: e.message,
    stack: e.stack,
  });
  res.status(500).json({
    error: {
      code: "internal_error",
      message: "An unexpected error occurred",
      details: null,
    },
  });
};
