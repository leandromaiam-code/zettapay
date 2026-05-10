import type { NextFunction, Request, RequestHandler, Response } from "express";

export interface SecurityHeadersOptions {
  /** When true, set HSTS — only safe behind TLS (Vercel, fronting LB). */
  enableHsts?: boolean;
  /** Override CSP. Default is API-appropriate (no inline scripts, no framing). */
  contentSecurityPolicy?: string;
}

const DEFAULT_CSP = [
  "default-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const DEFAULT_PERMISSIONS_POLICY = [
  "geolocation=()",
  "microphone=()",
  "camera=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ");

/**
 * Conservative security headers for a JSON-only API surface. Applied as the
 * first middleware so headers are present even on 404 / error paths. The CSP
 * is intentionally `default-src 'none'` because every endpoint returns JSON;
 * `/docs` and `/openapi` set their own `content-type` and are unaffected.
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): RequestHandler {
  const csp = options.contentSecurityPolicy ?? DEFAULT_CSP;
  const enableHsts = options.enableHsts ?? process.env.NODE_ENV === "production";

  return function securityHeadersMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", DEFAULT_PERMISSIONS_POLICY);
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Security-Policy", csp);
    if (enableHsts) {
      res.setHeader(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
    }
    next();
  };
}
