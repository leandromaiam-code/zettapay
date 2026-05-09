import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import { ValidationError } from "../lib/errors.js";
import { registerMerchant } from "./service.js";

const registerSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, "name must be at least 2 chars")
    .max(120, "name must be at most 120 chars"),
  email: z.string().trim().email("email must be a valid address").max(254),
  walletAddress: z
    .string()
    .trim()
    .min(32, "walletAddress must be a base58 Solana pubkey")
    .max(64, "walletAddress must be a base58 Solana pubkey"),
  webhookUrl: z
    .union([z.string().trim().url(), z.literal("")])
    .optional()
    .nullable(),
});

export function createMerchantsRouter(): Router {
  const router = Router();

  router.post("/register", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = registerSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new ValidationError("Invalid request body", parsed.error.flatten());
      }
      const result = await registerMerchant({
        name: parsed.data.name,
        email: parsed.data.email,
        walletAddress: parsed.data.walletAddress,
        webhookUrl: parsed.data.webhookUrl ?? null,
      });
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
