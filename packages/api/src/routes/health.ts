import { Router } from "express";

export function healthRouter(): Router {
  const router = Router();
  router.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "zettapay-api", uptimeSec: process.uptime() });
  });
  return router;
}
