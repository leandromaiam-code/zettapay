import { Router, type Request, type Response, type NextFunction } from 'express';
import type { MerchantRepository } from '../repository.js';
import { CreateOnrampUrlSchema } from '../validation.js';
import { BadRequest, NotFound, HttpError } from '../errors.js';
import {
  buildMoonPayUrl,
  type MoonPayConfig,
  MoonPayBuildError,
} from '../onramp.js';

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export interface OnrampRouterDeps {
  merchants: MerchantRepository;
  config: MoonPayConfig;
}

export function buildOnrampRouter({ merchants, config }: OnrampRouterDeps): Router {
  const router = Router();

  router.post(
    '/',
    asyncHandler((req, res) => {
      const parsed = CreateOnrampUrlSchema.safeParse(req.body);
      if (!parsed.success) {
        throw BadRequest('invalid payload', parsed.error.flatten());
      }
      const merchant = merchants.findById(parsed.data.merchant_id);
      if (!merchant) {
        throw NotFound('merchant');
      }

      try {
        const url = buildMoonPayUrl(config, {
          walletAddress: merchant.usdcAta,
          currencyCode: parsed.data.currency_code,
          baseCurrencyAmount: parsed.data.base_currency_amount,
          baseCurrencyCode: parsed.data.base_currency_code,
          redirectURL: parsed.data.redirect_url,
          externalCustomerId: parsed.data.external_customer_id,
          externalTransactionId: parsed.data.external_transaction_id,
        });
        res.status(200).json({
          url,
          environment: config.environment,
          merchantId: merchant.id,
          walletAddress: merchant.usdcAta,
        });
      } catch (err) {
        if (err instanceof MoonPayBuildError) {
          throw new HttpError(400, err.code, err.message);
        }
        throw err;
      }
    }),
  );

  return router;
}
