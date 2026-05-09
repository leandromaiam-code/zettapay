import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { registerMerchant } from "../services/merchants.js";
import { validate } from "../middleware/validate.js";
import { registerMerchantSchema, type RegisterMerchantBody } from "../lib/schemas.js";

export function merchantsRouter(db: Db): Router {
  const router = Router();

  router.post(
    "/merchants/register",
    validate({ body: registerMerchantSchema }),
    (req, res, next) => {
      try {
        const body = req.body as RegisterMerchantBody;
        const merchant = registerMerchant(db, {
          name: body.name,
          walletAddress: body.walletAddress,
          email: body.email,
          webhookUrl: body.webhookUrl ?? null,
        });
        res.status(201).json({ merchant });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
