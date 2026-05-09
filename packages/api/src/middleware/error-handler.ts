import type { ErrorRequestHandler, NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { HttpError, ValidationError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details: unknown;
  };
}

function serialize(error: HttpError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
    },
  };
}

function isZodError(err: unknown): err is ZodError {
  return err instanceof ZodError;
}

export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void => {
  if (isZodError(err)) {
    const wrapped = new ValidationError("Invalid request payload", {
      issues: err.issues.map((i) => ({
        path: i.path.join("."),
        code: i.code,
        message: i.message,
      })),
    });
    logger.warn("validation_error", {
      path: req.path,
      issues: wrapped.details,
    });
    res.status(wrapped.status).json(serialize(wrapped));
    return;
  }

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
    res.status(err.status).json(serialize(err));
    return;
  }

  const e = err instanceof Error ? err : new Error(String(err));
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

export const notFoundHandler = (req: Request, res: Response): void => {
  res.status(404).json({
    error: {
      code: "not_found",
      message: `Route ${req.method} ${req.path} does not exist`,
      details: null,
    },
  });
};
