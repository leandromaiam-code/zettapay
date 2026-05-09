import { Router, type Request, type Response, type NextFunction } from 'express';
import express from 'express';
import {
  MOONPAY_SIGNATURE_HEADER,
  MoonpayWebhookPayloadSchema,
  OnrampSignatureError,
  processOnrampWebhook,
  verifyMoonpaySignature,
  type OnrampNotifierOptions,
  type OnrampOutcome,
} from '../onramp.js';
import type { PaymentLog } from '../payments.js';
import type { dispatchWebhook } from '../webhook.js';

const RAW_BODY_LIMIT = '64kb';

export interface OnrampRouterOptions {
  payments: PaymentLog;
  webhookSecret: string | undefined;
  notify?: OnrampNotifierOptions;
  dispatch?: typeof dispatchWebhook;
  signatureToleranceMs?: number;
}

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function bodyToBuffer(req: Request): Buffer {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  return Buffer.alloc(0);
}

function summarize(outcome: OnrampOutcome) {
  if (outcome.kind === 'ignored') {
    return { accepted: true, ignored: true, reason: outcome.reason };
  }
  return {
    accepted: true,
    ignored: false,
    paymentId: outcome.record.id,
    deduplicated: !outcome.created,
    notified: outcome.dispatch?.delivered ?? null,
  };
}

export function buildOnrampRouter(options: OnrampRouterOptions): Router {
  const router = Router();

  router.post(
    '/webhook',
    express.raw({ type: '*/*', limit: RAW_BODY_LIMIT }),
    asyncHandler(async (req, res) => {
      if (!options.webhookSecret) {
        res
          .status(503)
          .json({ error: { code: 'onramp_disabled', message: 'onramp webhook secret not configured' } });
        return;
      }

      const rawBody = bodyToBuffer(req);
      const signatureHeader = req.header(MOONPAY_SIGNATURE_HEADER);

      try {
        verifyMoonpaySignature({
          signatureHeader,
          rawBody,
          secret: options.webhookSecret,
          toleranceMs: options.signatureToleranceMs,
        });
      } catch (err) {
        if (err instanceof OnrampSignatureError) {
          res.status(401).json({ error: { code: err.code, message: err.message } });
          return;
        }
        throw err;
      }

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawBody.toString('utf8') || 'null');
      } catch {
        res
          .status(400)
          .json({ error: { code: 'invalid_json', message: 'request body is not valid JSON' } });
        return;
      }

      const parsed = MoonpayWebhookPayloadSchema.safeParse(parsedJson);
      if (!parsed.success) {
        res.status(400).json({
          error: {
            code: 'invalid_payload',
            message: 'webhook payload does not match Moonpay event shape',
            details: parsed.error.flatten(),
          },
        });
        return;
      }

      const outcome = await processOnrampWebhook({
        payload: parsed.data,
        payments: options.payments,
        notify: options.notify,
        dispatch: options.dispatch,
      });

      res.status(200).json(summarize(outcome));
    }),
  );

  return router;
}
