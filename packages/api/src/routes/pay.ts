import { Router, type Request, type Response } from 'express';
import { x402PaymentMiddleware } from '../x402.js';

export function buildPayRouter(): Router {
  const router = Router();

  router.post('/', x402PaymentMiddleware(), (req: Request, res: Response) => {
    const payment = req.x402Payment;
    if (!payment) {
      res.status(500).json({ error: { code: 'internal_error', message: 'payment not parsed' } });
      return;
    }
    res.status(202).json({
      accepted: true,
      feePayer: payment.feePayer,
      signers: payment.signers,
      signatureCount: payment.signatures.length,
      recentBlockhash: payment.recentBlockhash,
      isVersioned: payment.isVersioned,
      version: payment.version,
      transactionBytes: payment.rawTransaction.length,
    });
  });

  return router;
}
