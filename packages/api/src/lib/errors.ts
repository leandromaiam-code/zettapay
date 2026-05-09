export type HttpErrorCode =
  | "validation_error"
  | "not_found"
  | "conflict"
  | "unauthorized"
  | "rate_limited"
  | "payment_failed"
  | "config_error"
  | "internal_error";

export class HttpError extends Error {
  readonly status: number;
  readonly code: HttpErrorCode;
  readonly details?: unknown;

  constructor(
    status: number,
    code: HttpErrorCode,
    message: string,
    details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown): HttpError {
    return new HttpError(400, "validation_error", message, details);
  }

  static notFound(message: string): HttpError {
    return new HttpError(404, "not_found", message);
  }

  static conflict(message: string): HttpError {
    return new HttpError(409, "conflict", message);
  }

  static paymentFailed(message: string, details?: unknown): HttpError {
    return new HttpError(502, "payment_failed", message, details);
  }

  static config(message: string): HttpError {
    return new HttpError(500, "config_error", message);
  }
}
