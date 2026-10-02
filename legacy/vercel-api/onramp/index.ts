import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HTTPS_RE = /^https:\/\//i;

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

function moonpayBaseUrl(env: string): string {
  return env === 'production' ? 'https://buy.moonpay.com' : 'https://buy-sandbox.moonpay.com';
}

function appendQuery(url: URL, key: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  url.searchParams.set(key, String(value));
}

function pickQuery(query: VercelRequest['query'], key: string): string | undefined {
  const raw = query[key];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const apiKey = process.env.MOONPAY_API_KEY?.trim();
  const environment =
    (process.env.MOONPAY_ENV?.trim().toLowerCase() === 'production' ? 'production' : 'sandbox') as
      | 'sandbox'
      | 'production';
  const defaultCurrency = process.env.MOONPAY_DEFAULT_CURRENCY?.trim() || 'usdc_sol';

  const walletAddress = pickQuery(req.query, 'walletAddress') ?? pickQuery(req.query, 'wallet');

  // Discovery / health response when no wallet supplied.
  if (!walletAddress) {
    res.status(200).json({
      service: SERVICE,
      runtime: RUNTIME,
      endpoint: '/api/onramp',
      method: 'GET',
      description:
        'Build a MoonPay fiat→USDC onramp URL. Pass ?walletAddress=<base58> plus optional currency/amount params and receive a redirect-ready URL.',
      provider: 'moonpay',
      environment,
      configured: Boolean(apiKey),
      defaultCurrency,
      query: {
        walletAddress: 'string (required, base58 Solana pubkey)',
        currencyCode: 'string (optional, default usdc_sol)',
        baseCurrencyCode: 'string (optional, e.g. usd, brl)',
        baseCurrencyAmount: 'number (optional, fiat prefill)',
        redirectURL: 'string (optional, https:// URL)',
        externalCustomerId: 'string (optional)',
        externalTransactionId: 'string (optional)',
      },
      webhook: '/api/onramp/webhook',
    });
    return;
  }

  if (!apiKey) {
    res.status(503).json({
      error: {
        code: 'onramp_disabled',
        message: 'MoonPay onramp not configured (set MOONPAY_API_KEY)',
      },
    });
    return;
  }

  if (!SOLANA_ADDRESS_RE.test(walletAddress)) {
    badRequest(res, 'invalid_wallet_address', 'walletAddress must be a base58 Solana pubkey');
    return;
  }

  const currencyCode = pickQuery(req.query, 'currencyCode') ?? defaultCurrency;
  const baseCurrencyCode = pickQuery(req.query, 'baseCurrencyCode');
  const baseAmountRaw = pickQuery(req.query, 'baseCurrencyAmount');
  const redirectURL = pickQuery(req.query, 'redirectURL');
  const externalCustomerId = pickQuery(req.query, 'externalCustomerId');
  const externalTransactionId = pickQuery(req.query, 'externalTransactionId');

  let baseCurrencyAmount: number | undefined;
  if (baseAmountRaw !== undefined) {
    const parsed = Number(baseAmountRaw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      badRequest(res, 'invalid_amount', 'baseCurrencyAmount must be a positive number');
      return;
    }
    baseCurrencyAmount = parsed;
  }

  if (redirectURL && !HTTPS_RE.test(redirectURL)) {
    badRequest(res, 'invalid_redirect_url', 'redirectURL must be an https:// URL');
    return;
  }

  const url = new URL(moonpayBaseUrl(environment));
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('walletAddress', walletAddress);
  url.searchParams.set('currencyCode', currencyCode);
  appendQuery(url, 'baseCurrencyCode', baseCurrencyCode);
  appendQuery(url, 'baseCurrencyAmount', baseCurrencyAmount);
  appendQuery(url, 'redirectURL', redirectURL);
  appendQuery(url, 'externalCustomerId', externalCustomerId);
  appendQuery(url, 'externalTransactionId', externalTransactionId);

  res.status(200).json({
    provider: 'moonpay',
    environment,
    walletAddress,
    currencyCode,
    url: url.toString(),
  });
}
