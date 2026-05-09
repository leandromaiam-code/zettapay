import express, { type Express, type Request, type Response } from "express";
import { getConfig } from "./config.js";
import { errorHandler } from "./middleware/error-handler.js";
import { createMerchantsRouter } from "./merchants/routes.js";

export function createApp(): Express {
  const app = express();
  const cfg = getConfig();

  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "64kb" }));

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({
      ok: true,
      cluster: cfg.solana.cluster,
      usdcMint: cfg.solana.usdcMint,
    });
  });

  app.use("/merchants", createMerchantsRouter());

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: { code: "not_found", message: "Route not found", details: null },
    });
  });

  app.use(errorHandler);
  return app;
}
