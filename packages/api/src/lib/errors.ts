export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, "validation_error", message, details);
    this.name = "ValidationError";
  }
}

export class ConflictError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(409, "conflict", message, details);
    this.name = "ConflictError";
  }
}

export class ConfigurationError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(503, "configuration_error", message, details);
    this.name = "ConfigurationError";
  }
}

export class UpstreamError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(502, "upstream_error", message, details);
    this.name = "UpstreamError";
  }
}
