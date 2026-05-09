import { z } from 'zod';

const SOLANA_BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const walletPubkey = z
  .string()
  .trim()
  .min(32, 'wallet_pubkey must be a base58 Solana address')
  .max(44, 'wallet_pubkey must be a base58 Solana address')
  .regex(SOLANA_BASE58, 'wallet_pubkey must be a base58 Solana address');

const usdcAta = z
  .string()
  .trim()
  .min(32, 'usdc_ata must be a base58 Solana address')
  .max(44, 'usdc_ata must be a base58 Solana address')
  .regex(SOLANA_BASE58, 'usdc_ata must be a base58 Solana address');

export const CreateMerchantSchema = z.object({
  name: z.string().trim().min(1, 'name is required').max(120),
  wallet_pubkey: walletPubkey,
  usdc_ata: usdcAta,
});

export const UpdateMerchantSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    wallet_pubkey: walletPubkey.optional(),
    usdc_ata: usdcAta.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'at least one field is required',
  });

export const ListMerchantsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const IdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export type CreateMerchantBody = z.infer<typeof CreateMerchantSchema>;
export type UpdateMerchantBody = z.infer<typeof UpdateMerchantSchema>;
