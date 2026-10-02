/**
 * Error raised for every failed call of `ZettaPayApi`. `code` is the server's
 * `error.code` when the response carried the standard envelope, otherwise one
 * of the client-side codes: `http_error`, `network_error`, `timeout`,
 * `invalid_response`, `invalid_request`, `asset_mismatch`.
 */
export class ZettaPayApiError extends Error {
  /** Stable machine-readable code. */
  readonly code: string;
  /** HTTP status, when a response was received. */
  readonly status?: number;
  /** Decoded response body (or other context), when available. */
  readonly details?: unknown;

  constructor(
    message: string,
    code: string,
    status?: number,
    details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = 'ZettaPayApiError';
    this.code = code;
    this.status = status;
    this.details = details;
    if (options?.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * HTTP 402 `plan_limit_reached` — ZettaPay Cloud refused to create an invoice
 * because the merchant's plan reached its monthly invoice cap. Existing
 * invoices are unaffected.
 */
export class PlanLimitReachedError extends ZettaPayApiError {
  /** Plan the merchant is on, as reported by the server. */
  readonly plan?: string;
  /** Monthly invoice cap of that plan. */
  readonly limit?: number;
  /** Invoices already created this month. */
  readonly used?: number;

  constructor(
    message: string,
    info: { plan?: string; limit?: number; used?: number },
    details?: unknown,
  ) {
    super(message, 'plan_limit_reached', 402, details);
    this.name = 'PlanLimitReachedError';
    this.plan = info.plan;
    this.limit = info.limit;
    this.used = info.used;
  }
}

/** HTTP 429 — too many invoice requests. */
export class RateLimitedError extends ZettaPayApiError {
  /** Value of the `Retry-After` response header in seconds, when sent. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number, details?: unknown) {
    super(message, 'rate_limited', 429, details);
    this.name = 'RateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}
