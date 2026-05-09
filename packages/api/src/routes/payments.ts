import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import type { PaymentLog } from '../payments.js';
import { BadRequest, NotFound } from '../errors.js';

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const IdParamSchema = z.object({
  id: z.string().trim().min(1).max(64),
});

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function buildPaymentsRouter(payments: PaymentLog): Router {
  const router = Router();

  router.get(
    '/',
    asyncHandler((req, res) => {
      const query = ListQuerySchema.safeParse(req.query);
      if (!query.success) {
        throw BadRequest('invalid query', query.error.flatten());
      }
      const items = payments.list(query.data);
      res.json({ items, count: items.length, total: payments.count() });
    }),
  );

  router.get(
    '/:id',
    asyncHandler((req, res) => {
      const params = IdParamSchema.safeParse(req.params);
      if (!params.success) {
        throw BadRequest('invalid id', params.error.flatten());
      }
      const record = payments.findById(params.data.id);
      if (!record) {
        throw NotFound('payment');
      }
      res.json(record);
    }),
  );

  return router;
}
