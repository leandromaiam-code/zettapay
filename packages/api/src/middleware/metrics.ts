import type { NextFunction, Request, Response } from "express";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
} from "../lib/metrics.js";

const NS_PER_SEC = 1e9;

function statusClass(status: number): string {
  if (status >= 500) return "5xx";
  if (status >= 400) return "4xx";
  if (status >= 300) return "3xx";
  if (status >= 200) return "2xx";
  return "1xx";
}

function resolveRoute(req: Request): string {
  // Express populates req.route only after the matching router runs. For the
  // 404 path or static handlers it can be missing — we collapse those to
  // "unmatched" to keep label cardinality bounded (raw req.path would explode
  // the histogram series).
  const route = (req as Request & { route?: { path?: string } }).route?.path;
  if (typeof route === "string" && route.length > 0) {
    const baseUrl = (req as Request & { baseUrl?: string }).baseUrl ?? "";
    return baseUrl ? `${baseUrl}${route}` : route;
  }
  return "unmatched";
}

/**
 * Records request count + latency histogram for every Express response. Plug
 * in early in the middleware chain so the timing brackets the entire handler.
 *
 * Skips its own metrics endpoint to avoid biasing latency stats with the
 * cheap text-format render call.
 */
export function metricsMiddleware() {
  return function metrics(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (req.path === "/metrics") {
      next();
      return;
    }
    const startNs = process.hrtime.bigint();
    res.on("finish", () => {
      const elapsedSec = Number(process.hrtime.bigint() - startNs) / NS_PER_SEC;
      const route = resolveRoute(req);
      const method = req.method.toUpperCase();
      const status = String(res.statusCode);
      httpRequestsTotal.inc(
        { method, route, status, status_class: statusClass(res.statusCode) },
        1,
      );
      httpRequestDurationSeconds.observe({ method, route }, elapsedSec);
    });
    next();
  };
}
