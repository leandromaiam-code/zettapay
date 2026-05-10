import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { IncidentService } from "../services/incident.js";

/**
 * Z22.4 — kill-switch guard. When an open sev1 incident has `killSwitch=true`,
 * payment-creation traffic is short-circuited with HTTP 503 + Retry-After so
 * upstream clients (SDK, x402 wallets, Shopify checkout) back off cleanly.
 *
 * Returns a JSON envelope rather than the standard error_handler shape because
 * status-page scrapers and merchant SDK retries should be able to detect the
 * kill switch without parsing free-form messages.
 */
export function incidentGuard(incidents: IncidentService): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction) => {
    if (!incidents.isKillSwitchEngaged()) {
      next();
      return;
    }
    res.setHeader("Retry-After", "60");
    res.status(503).json({
      error: {
        code: "service_paused",
        message:
          "Payments are temporarily paused while an incident is being mitigated. See https://status.zettapay.io",
      },
      status: "service_paused",
    });
  };
}
