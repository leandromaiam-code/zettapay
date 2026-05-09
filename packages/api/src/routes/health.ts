import { Router } from "express";
import type { SolanaConnectionService } from "../lib/solana.js";

export function healthRouter(service: SolanaConnectionService): Router {
  const router = Router();

  router.get("/", (_req, res) => {
    res.json({ ok: true, service: "zettapay-api" });
  });

  router.get("/solana", async (_req, res) => {
    const status = await service.getHealth();
    res.status(status.ok ? 200 : 503).json({
      ...status,
      network: service.network,
      rpcUrl: service.rpcUrl,
    });
  });

  return router;
}
