import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  type OnrampPaymentDetails,
  type PaymentLog,
  type PaymentRecord,
} from './payments.js';
import { dispatchWebhook, type WebhookDispatchResult } from './webhook.js';

export const MOONPAY_SIGNATURE_HEADER = 'moonpay-signature-v2';
export const PAYMENT_CONFIRMED_EVENT = 'payment.confirmed';

export type OnrampVerificationCode =
  | 'missing_signature'
  | 'invalid_signature_format'
  | 'expired_signature'
  | 'invalid_signature';

export class OnrampSignatureError extends Error {
  constructor(public readonly code: OnrampVerificationCode, message: string) {
    super(message);
    this.name = 'OnrampSignatureError';
  }
}

export interface VerifyMoonpaySignatureOptions {
  signatureHeader: string | undefined;
  rawBody: Buffer | string;
  secret: string;
  toleranceMs?: number;
  now?: () => number;
}

const DEFAULT_TOLERANCE_MS = 5 * 60 * 1_000;

export function verifyMoonpaySignature(options: VerifyMoonpaySignatureOptions): {
  timestamp: number;
} {
  const { signatureHeader, rawBody, secret, toleranceMs = DEFAULT_TOLERANCE_MS } = options;
  const now = options.now ?? Date.now;

  if (!signatureHeader) {
    throw new OnrampSignatureError('missing_signature', 'signature header is required');
  }

  const parts = signatureHeader.split(',').map((part) => part.trim());
  let timestampRaw: string | undefined;
  let signatureHex: string | undefined;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestampRaw = value;
    else if (key === 's') signatureHex = value;
  }

  if (!timestampRaw || !signatureHex) {
    throw new OnrampSignatureError(
      'invalid_signature_format',
      'signature header must contain t=<timestamp>,s=<hex>',
    );
  }
  const timestamp = Number.parseInt(timestampRaw, 10);
  if (!Number.isFinite(timestamp)) {
    throw new OnrampSignatureError(
      'invalid_signature_format',
      'signature timestamp must be a numeric epoch in milliseconds',
    );
  }

  const skew = Math.abs(now() - timestamp);
  if (skew > toleranceMs) {
    throw new OnrampSignatureError(
      'expired_signature',
      `signature timestamp drift ${skew}ms exceeds tolerance ${toleranceMs}ms`,
    );
  }

  const bodyBuffer = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = createHmac('sha256', secret)
    .update(`${timestampRaw}.`)
    .update(bodyBuffer)
    .digest('hex');

  if (!safeEqualHex(expected, signatureHex)) {
    throw new OnrampSignatureError('invalid_signature', 'signature digest does not match payload');
  }

  return { timestamp };
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

const Currency = z.object({ code: z.string().min(1) });

const MoonpayTransaction = z.object({
  id: z.string().min(1),
  externalTransactionId: z.string().min(1).optional(),
  status: z.string().min(1),
  baseCurrencyAmount: z.number().nonnegative().optional(),
  quoteCurrencyAmount: z.number().nonnegative().optional(),
  walletAddress: z.string().min(1).optional(),
  baseCurrency: Currency.optional(),
  quoteCurrency: Currency.optional(),
  createdAt: z.string().min(1).optional(),
  updatedAt: z.string().min(1).optional(),
});

export const MoonpayWebhookPayloadSchema = z
  .object({
    type: z.string().min(1),
    data: MoonpayTransaction,
  })
  .strict({ message: 'unexpected top-level fields' });

export type MoonpayWebhookPayload = z.infer<typeof MoonpayWebhookPayloadSchema>;

export type OnrampOutcome =
  | { kind: 'recorded'; record: PaymentRecord; created: boolean; dispatch?: WebhookDispatchResult }
  | { kind: 'ignored'; reason: 'unsupported_event' | 'incomplete_status' };

export interface OnrampNotifierOptions {
  url: string;
  secret?: string;
}

export interface ProcessOnrampWebhookOptions {
  payload: MoonpayWebhookPayload;
  payments: PaymentLog;
  notify?: OnrampNotifierOptions;
  dispatch?: typeof dispatchWebhook;
}

const COMPLETION_EVENT = 'transaction_updated';
const COMPLETED_STATUS = 'completed';

export async function processOnrampWebhook(
  options: ProcessOnrampWebhookOptions,
): Promise<OnrampOutcome> {
  const { payload, payments } = options;

  if (payload.type !== COMPLETION_EVENT) {
    return { kind: 'ignored', reason: 'unsupported_event' };
  }
  if (payload.data.status !== COMPLETED_STATUS) {
    return { kind: 'ignored', reason: 'incomplete_status' };
  }

  const externalId = payload.data.externalTransactionId ?? payload.data.id;
  const existing = payments.findOnrampByExternalId('moonpay', externalId);
  if (existing) {
    return { kind: 'recorded', record: existing, created: false };
  }

  const details: OnrampPaymentDetails = {
    provider: 'moonpay',
    externalTransactionId: externalId,
    status: 'completed',
    baseAmount: payload.data.baseCurrencyAmount ?? 0,
    baseCurrency: payload.data.baseCurrency?.code ?? '',
    quoteAmount: payload.data.quoteCurrencyAmount ?? 0,
    quoteCurrency: payload.data.quoteCurrency?.code ?? '',
    walletAddress: payload.data.walletAddress ?? '',
    providerCreatedAt: payload.data.createdAt ?? null,
    providerCompletedAt: payload.data.updatedAt ?? null,
  };

  const record = payments.recordOnramp(details);

  let dispatch: WebhookDispatchResult | undefined;
  if (options.notify?.url) {
    const dispatchFn = options.dispatch ?? dispatchWebhook;
    dispatch = await dispatchFn({
      url: options.notify.url,
      secret: options.notify.secret,
      eventId: record.id,
      payload: {
        event: PAYMENT_CONFIRMED_EVENT,
        paymentId: record.id,
        source: 'onramp',
        provider: details.provider,
        externalTransactionId: details.externalTransactionId,
        baseAmount: details.baseAmount,
        baseCurrency: details.baseCurrency,
        quoteAmount: details.quoteAmount,
        quoteCurrency: details.quoteCurrency,
        walletAddress: details.walletAddress,
        confirmedAt: record.acceptedAt,
      },
    });
  }

  return { kind: 'recorded', record, created: true, dispatch };
}

export type MoonPayEnvironment = 'sandbox' | 'production';

export interface MoonPayConfig {
  apiKey: string;
  environment: MoonPayEnvironment;
  defaultCurrencyCode?: string;
}

export type MoonPayBuildErrorCode =
  | 'invalid_wallet_address'
  | 'invalid_currency_code'
  | 'invalid_amount'
  | 'invalid_redirect_url';

export class MoonPayBuildError extends Error {
  constructor(public readonly code: MoonPayBuildErrorCode, message: string) {
    super(message);
    this.name = 'MoonPayBuildError';
  }
}

export interface BuildMoonPayUrlParams {
  walletAddress: string;
  currencyCode?: unknown;
  baseCurrencyCode?: unknown;
  baseCurrencyAmount?: unknown;
  redirectURL?: unknown;
  externalCustomerId?: unknown;
  externalTransactionId?: unknown;
}

const CURRENCY_CODE_RE = /^[a-zA-Z0-9_]{2,20}$/;

export function buildMoonPayUrl(
  config: MoonPayConfig,
  params: BuildMoonPayUrlParams,
): string {
  if (!params.walletAddress || typeof params.walletAddress !== 'string') {
    throw new MoonPayBuildError('invalid_wallet_address', 'walletAddress is required');
  }

  const url = new URL(
    config.environment === 'production'
      ? 'https://buy.moonpay.com/'
      : 'https://buy-sandbox.moonpay.com/',
  );
  url.searchParams.set('apiKey', config.apiKey);
  url.searchParams.set('walletAddress', params.walletAddress);

  const currencyCode =
    typeof params.currencyCode === 'string'
      ? params.currencyCode
      : config.defaultCurrencyCode;
  if (currencyCode !== undefined) {
    if (!CURRENCY_CODE_RE.test(currencyCode)) {
      throw new MoonPayBuildError('invalid_currency_code', 'currencyCode is invalid');
    }
    url.searchParams.set('currencyCode', currencyCode);
  }

  if (params.baseCurrencyCode !== undefined) {
    if (typeof params.baseCurrencyCode !== 'string' || !CURRENCY_CODE_RE.test(params.baseCurrencyCode)) {
      throw new MoonPayBuildError('invalid_currency_code', 'baseCurrencyCode is invalid');
    }
    url.searchParams.set('baseCurrencyCode', params.baseCurrencyCode);
  }

  if (params.baseCurrencyAmount !== undefined) {
    if (
      typeof params.baseCurrencyAmount !== 'number' ||
      !Number.isFinite(params.baseCurrencyAmount) ||
      params.baseCurrencyAmount <= 0
    ) {
      throw new MoonPayBuildError('invalid_amount', 'baseCurrencyAmount must be positive');
    }
    url.searchParams.set('baseCurrencyAmount', String(params.baseCurrencyAmount));
  }

  if (params.redirectURL !== undefined) {
    if (typeof params.redirectURL !== 'string') {
      throw new MoonPayBuildError('invalid_redirect_url', 'redirectURL must be a string');
    }
    try {
      // eslint-disable-next-line no-new
      new URL(params.redirectURL);
    } catch {
      throw new MoonPayBuildError('invalid_redirect_url', 'redirectURL is not a valid URL');
    }
    url.searchParams.set('redirectURL', params.redirectURL);
  }

  if (typeof params.externalCustomerId === 'string' && params.externalCustomerId.length > 0) {
    url.searchParams.set('externalCustomerId', params.externalCustomerId);
  }
  if (typeof params.externalTransactionId === 'string' && params.externalTransactionId.length > 0) {
    url.searchParams.set('externalTransactionId', params.externalTransactionId);
  }

  return url.toString();
}

export class MoonPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoonPayConfigError';
  }
}

export function loadMoonPayConfig(env: NodeJS.ProcessEnv = process.env): MoonPayConfig {
  const apiKey = env.MOONPAY_API_KEY?.trim();
  if (!apiKey) {
    throw new MoonPayConfigError('MOONPAY_API_KEY is not configured');
  }
  const envValue = (env.MOONPAY_ENV ?? 'sandbox').trim().toLowerCase();
  if (envValue !== 'sandbox' && envValue !== 'production') {
    throw new MoonPayConfigError(`MOONPAY_ENV must be "sandbox" or "production" (got "${envValue}")`);
  }
  const defaultCurrencyCode = env.MOONPAY_DEFAULT_CURRENCY?.trim();
  return {
    apiKey,
    environment: envValue,
    ...(defaultCurrencyCode ? { defaultCurrencyCode } : {}),
  };
}
