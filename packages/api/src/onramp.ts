const SANDBOX_BASE_URL = 'https://buy-sandbox.moonpay.com';
const PRODUCTION_BASE_URL = 'https://buy.moonpay.com';
const DEFAULT_CURRENCY_CODE = 'usdc_sol';

export type MoonPayEnvironment = 'sandbox' | 'production';

export interface MoonPayConfig {
  apiKey: string;
  environment: MoonPayEnvironment;
  defaultCurrencyCode: string;
}

export interface MoonPayUrlInput {
  walletAddress: string;
  currencyCode?: string;
  baseCurrencyAmount?: number;
  baseCurrencyCode?: string;
  redirectURL?: string;
  externalCustomerId?: string;
  externalTransactionId?: string;
}

export class MoonPayConfigError extends Error {
  constructor(
    public readonly code: 'missing_api_key' | 'invalid_environment',
    message: string,
  ) {
    super(message);
    this.name = 'MoonPayConfigError';
  }
}

export class MoonPayBuildError extends Error {
  constructor(
    public readonly code:
      | 'missing_wallet_address'
      | 'invalid_amount'
      | 'invalid_currency_code'
      | 'invalid_redirect_url',
    message: string,
  ) {
    super(message);
    this.name = 'MoonPayBuildError';
  }
}

const ENV_VALUES: readonly MoonPayEnvironment[] = ['sandbox', 'production'];

function parseEnvironment(raw: string | undefined): MoonPayEnvironment {
  const value = (raw ?? 'sandbox').trim().toLowerCase();
  if (value === 'sandbox' || value === 'production') {
    return value;
  }
  if (value === 'prod') return 'production';
  if (value === 'dev' || value === 'test') return 'sandbox';
  throw new MoonPayConfigError(
    'invalid_environment',
    `MOONPAY_ENV must be one of ${ENV_VALUES.join(', ')} (got "${raw}")`,
  );
}

export function loadMoonPayConfig(env: NodeJS.ProcessEnv = process.env): MoonPayConfig {
  const apiKey = env.MOONPAY_API_KEY?.trim();
  if (!apiKey) {
    throw new MoonPayConfigError(
      'missing_api_key',
      'MOONPAY_API_KEY is required to build MoonPay onramp URLs',
    );
  }
  const environment = parseEnvironment(env.MOONPAY_ENV);
  const defaultCurrencyCode = env.MOONPAY_DEFAULT_CURRENCY?.trim() || DEFAULT_CURRENCY_CODE;
  return { apiKey, environment, defaultCurrencyCode };
}

export function moonPayBaseUrl(environment: MoonPayEnvironment): string {
  return environment === 'production' ? PRODUCTION_BASE_URL : SANDBOX_BASE_URL;
}

const CURRENCY_CODE_PATTERN = /^[a-z0-9_]{2,20}$/;

function ensureCurrencyCode(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!CURRENCY_CODE_PATTERN.test(normalized)) {
    throw new MoonPayBuildError(
      'invalid_currency_code',
      `${field} must match ${CURRENCY_CODE_PATTERN.source}`,
    );
  }
  return normalized;
}

function ensureAmount(value: number, field: string): string {
  if (!Number.isFinite(value) || value <= 0) {
    throw new MoonPayBuildError('invalid_amount', `${field} must be a positive finite number`);
  }
  return value.toFixed(2).replace(/\.?0+$/, '') || '0';
}

function ensureRedirectUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MoonPayBuildError('invalid_redirect_url', 'redirectURL must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new MoonPayBuildError('invalid_redirect_url', 'redirectURL must use http or https');
  }
  return parsed.toString();
}

export function buildMoonPayUrl(config: MoonPayConfig, input: MoonPayUrlInput): string {
  const wallet = input.walletAddress?.trim();
  if (!wallet) {
    throw new MoonPayBuildError('missing_wallet_address', 'walletAddress is required');
  }

  const currencyCode = ensureCurrencyCode(
    input.currencyCode ?? config.defaultCurrencyCode,
    'currencyCode',
  );

  const url = new URL(moonPayBaseUrl(config.environment));
  url.searchParams.set('apiKey', config.apiKey);
  url.searchParams.set('currencyCode', currencyCode);
  url.searchParams.set('walletAddress', wallet);

  if (input.baseCurrencyCode !== undefined) {
    url.searchParams.set('baseCurrencyCode', ensureCurrencyCode(input.baseCurrencyCode, 'baseCurrencyCode'));
  }
  if (input.baseCurrencyAmount !== undefined) {
    url.searchParams.set('baseCurrencyAmount', ensureAmount(input.baseCurrencyAmount, 'baseCurrencyAmount'));
  }
  if (input.redirectURL !== undefined) {
    url.searchParams.set('redirectURL', ensureRedirectUrl(input.redirectURL));
  }
  if (input.externalCustomerId !== undefined) {
    const id = input.externalCustomerId.trim();
    if (id) url.searchParams.set('externalCustomerId', id);
  }
  if (input.externalTransactionId !== undefined) {
    const id = input.externalTransactionId.trim();
    if (id) url.searchParams.set('externalTransactionId', id);
  }

  return url.toString();
}
