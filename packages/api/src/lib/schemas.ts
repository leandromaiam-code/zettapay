import { z } from "zod";
import { PublicKey } from "@solana/web3.js";

const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const solanaPublicKey = z
  .string()
  .trim()
  .min(32)
  .max(64)
  .regex(SOLANA_BASE58, "must be a base58-encoded Solana public key")
  .transform((value, ctx) => {
    try {
      return new PublicKey(value).toBase58();
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a valid base58 Solana public key",
      });
      return z.NEVER;
    }
  });

export const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => /^https?:\/\//i.test(value),
    "must use http(s) scheme",
  );

export const registerMerchantSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  walletAddress: solanaPublicKey,
  webhookUrl: httpUrl.optional().nullable(),
});

export const createPaymentSchema = z.object({
  merchantId: z.string().trim().min(1).max(64),
  amountUsdc: z
    .number()
    .finite()
    .positive()
    .max(1_000_000, "amountUsdc cannot exceed 1,000,000"),
  payerWallet: solanaPublicKey.optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
});

export type RegisterMerchantBody = z.infer<typeof registerMerchantSchema>;
export type CreatePaymentBody = z.infer<typeof createPaymentSchema>;
