import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { MerchantRepository } from '../repository.js';
import type { PaymentLog } from '../payments.js';
import { BadRequest, NotFound } from '../errors.js';
import { base58Encode } from '../base58.js';
import type { Merchant } from '../types.js';

export const SIMULATE_NETWORK = 'solana-devnet';
export const SIMULATE_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
export const SIMULATE_DISCLAIMER =
  'Hackathon demo simulator — no real money is moved on Solana devnet or mainnet.';

const DEFAULT_AIRDROP_USDC = 100;
const DEFAULT_PAYMENT_USDC = 1;
const MIN_AMOUNT = 0.000001;
const MAX_AMOUNT = 1_000_000;

const SimulateParamsSchema = z.object({
  merchant: z.string().trim().min(1).max(64),
});

const SimulateQuerySchema = z.object({
  airdrop: z.coerce.number().min(MIN_AMOUNT).max(MAX_AMOUNT).optional(),
  amount: z.coerce.number().min(MIN_AMOUNT).max(MAX_AMOUNT).optional(),
});

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function resolveMerchantRef(repo: MerchantRepository, ref: string): Merchant | null {
  const handle = ref.startsWith('@') ? ref.slice(1) : ref;
  if (handle.length === 0) return null;
  if (/^\d+$/.test(handle)) {
    return repo.findById(Number(handle));
  }
  return repo.findByWallet(handle);
}

function fakeSignature(): string {
  return base58Encode(randomBytes(64));
}

function fakePubkey(): string {
  return base58Encode(randomBytes(32));
}

function fakeBlockhash(): string {
  return base58Encode(randomBytes(32));
}

function toMicroUsdc(amount: number): string {
  return Math.round(amount * 1_000_000).toString();
}

export interface SimulateRouterDeps {
  merchants: MerchantRepository;
  payments: PaymentLog;
}

export function buildSimulateRouter(deps: SimulateRouterDeps): Router {
  const router = Router();

  router.get(
    '/:merchant',
    asyncHandler((req, res) => {
      const params = SimulateParamsSchema.safeParse(req.params);
      if (!params.success) {
        throw BadRequest('invalid merchant reference', params.error.flatten());
      }
      const query = SimulateQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw BadRequest('invalid query', query.error.flatten());
      }

      const merchant = resolveMerchantRef(deps.merchants, params.data.merchant);
      if (!merchant) {
        throw NotFound('merchant');
      }

      const airdropAmount = query.data.airdrop ?? DEFAULT_AIRDROP_USDC;
      const paymentAmount = query.data.amount ?? DEFAULT_PAYMENT_USDC;

      const payerPubkey = fakePubkey();
      const airdropSignature = fakeSignature();
      const paymentSignature = fakeSignature();
      const blockhash = fakeBlockhash();

      const record = deps.payments.record({
        feePayer: payerPubkey,
        signers: [payerPubkey],
        signatures: [paymentSignature],
        recentBlockhash: blockhash,
        isVersioned: true,
        version: 0,
        transactionBytes: 0,
      });

      res.json({
        simulated: true,
        network: SIMULATE_NETWORK,
        disclaimer: SIMULATE_DISCLAIMER,
        merchant,
        airdrop: {
          recipient: merchant.usdcAta,
          amount: airdropAmount,
          amountMicroUsdc: toMicroUsdc(airdropAmount),
          currency: 'USDC',
          mint: SIMULATE_USDC_MINT,
          signature: airdropSignature,
        },
        payment: {
          id: record.id,
          from: payerPubkey,
          to: merchant.usdcAta,
          amount: paymentAmount,
          amountMicroUsdc: toMicroUsdc(paymentAmount),
          currency: 'USDC',
          mint: SIMULATE_USDC_MINT,
          signature: paymentSignature,
          recentBlockhash: blockhash,
          acceptedAt: record.acceptedAt,
        },
      });
    }),
  );

  return router;
}
