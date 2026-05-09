import { Router, type Request, type Response, type NextFunction } from 'express';
import type { MerchantRepository } from '../repository.js';
import {
  CreateMerchantSchema,
  IdParamSchema,
  ListMerchantsQuerySchema,
  UpdateMerchantSchema,
} from '../validation.js';
import { BadRequest, Conflict, NotFound } from '../errors.js';

const UNIQUE_VIOLATION = /UNIQUE constraint failed/i;

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function buildMerchantsRouter(repo: MerchantRepository): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const query = ListMerchantsQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw BadRequest('invalid query', query.error.flatten());
      }
      const items = repo.list(query.data);
      res.json({ items, count: items.length });
    }),
  );

  router.post(
    '/',
    asyncHandler((req, res) => {
      const parsed = CreateMerchantSchema.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('invalid payload', parsed.error.flatten());
      }
      try {
        const merchant = repo.create({
          name: parsed.data.name,
          walletPubkey: parsed.data.wallet_pubkey,
          usdcAta: parsed.data.usdc_ata,
        });
        res.status(201).json(merchant);
      } catch (err) {
        if (err instanceof Error && UNIQUE_VIOLATION.test(err.message)) {
          throw Conflict('wallet_pubkey or usdc_ata already registered');
        }
        throw err;
      }
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw BadRequest('invalid id', params.error.flatten());
      }
      const merchant = repo.findById(params.data.id);
      if (!merchant) {
        throw NotFound('merchant');
      }
      res.json(merchant);
    }),
  );

  router.patch(
    '/:id',
    asyncHandler((req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw BadRequest('invalid id', params.error.flatten());
      }
      const parsed = UpdateMerchantSchema.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('invalid payload', parsed.error.flatten());
      }
      try {
        const merchant = repo.update(params.data.id, {
          name: parsed.data.name,
          walletPubkey: parsed.data.wallet_pubkey,
          usdcAta: parsed.data.usdc_ata,
        });
        if (!merchant) {
          throw NotFound('merchant');
        }
        res.json(merchant);
      } catch (err) {
        if (err instanceof Error && UNIQUE_VIOLATION.test(err.message)) {
          throw Conflict('wallet_pubkey or usdc_ata already registered');
        }
        throw err;
      }
    }),
  );

  router.delete(
    '/:id',
    asyncHandler((req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw BadRequest('invalid id', params.error.flatten());
      }
      const removed = repo.delete(params.data.id);
      if (!removed) {
        throw NotFound('merchant');
      }
      res.status(204).end();
    }),
  );

  return router;
}
