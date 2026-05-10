import { randomUUID } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const MAX_AMOUNT = 1_000_000;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED_CURRENCIES = ['USDC', 'USD', 'BRL', 'EUR'];

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: SERVICE,
      runtime: RUNTIME,
      endpoint: '/api/pay',
      method: 'POST',
      description:
        'Create a payment intent. Settlement instant via Solana USDC. Idempotent via Idempotency-Key.',
      requestBody: {
        merchantId: 'string (required, max 64 chars)',
        amount: 'number (required, positive, ≤1,000,000)',
        currency: 'string (optional, default USDC)',
        payerWallet: 'string (optional, base58 Solana pubkey)',
        metadata: 'object (optional, free-form JSON)',
      },
      headers: { 'Idempotency-Key': 'string (recommended, ≤128 chars)' },
      fees: { rate: '0.30%', settlement: 'instant' },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;

  const merchantId = typeof body.merchantId === 'string' ? body.merchantId.trim() : '';
  if (!merchantId || merchantId.length > 64) {
    badRequest(res, 'invalid_merchant_id', 'Field "merchantId" is required and must be ≤64 chars');
    return;
  }

  const rawAmount = body.amount ?? body.amountUsdc;
  const amount = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
  if (!Number.isFinite(amount) || amount <= 0) {
    badRequest(res, 'invalid_amount', 'Field "amount" must be a positive number');
    return;
  }
  if (amount > MAX_AMOUNT) {
    badRequest(res, 'amount_too_large', `Field "amount" cannot exceed ${MAX_AMOUNT}`);
    return;
  }

  const currencyRaw = typeof body.currency === 'string' ? body.currency.trim().toUpperCase() : 'USDC';
  if (!ALLOWED_CURRENCIES.includes(currencyRaw)) {
    badRequest(
      res,
      'invalid_currency',
      `Field "currency" must be one of: ${ALLOWED_CURRENCIES.join(', ')}`,
    );
    return;
  }

  const payerWallet = typeof body.payerWallet === 'string' ? body.payerWallet.trim() : '';
  if (payerWallet && !SOLANA_ADDRESS_RE.test(payerWallet)) {
    badRequest(res, 'invalid_payer_wallet', 'Field "payerWallet" must be a base58 Solana pubkey');
    return;
  }

  const metadataRaw = body.metadata;
  const metadata =
    metadataRaw && typeof metadataRaw === 'object' && !Array.isArray(metadataRaw)
      ? (metadataRaw as Record<string, unknown>)
      : null;

  const idemHeader = req.headers['idempotency-key'];
  const idemKey = Array.isArray(idemHeader) ? idemHeader[0] : idemHeader;
  if (idemKey !== undefined && (typeof idemKey !== 'string' || idemKey.length > 128)) {
    badRequest(res, 'invalid_idempotency_key', 'Header "Idempotency-Key" must be ≤128 chars');
    return;
  }

  const paymentId = `pay_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const now = new Date().toISOString();

  res.status(201).json({
    payment: {
      id: paymentId,
      merchantId,
      amount,
      amountUsdc: amount,
      currency: currencyRaw,
      payerWallet: payerWallet || null,
      status: 'pending',
      txSignature: null,
      metadata,
      network: 'solana-devnet',
      fee: Math.round(amount * 0.003 * 1_000_000) / 1_000_000,
      createdAt: now,
      completedAt: null,
    },
    txSignature: null,
    next: {
      submit: `/api/pay/${paymentId}/submit`,
      poll: `/api/payments/${paymentId}`,
    },
  });
}
