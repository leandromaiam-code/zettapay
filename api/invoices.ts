import { createHash, randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

/** Chains ZettaPay watches via on-chain listeners (Z45/Z46/Z47). */
const SUPPORTED_CHAINS = ['btc', 'base', 'polygon', 'ethereum'] as const;
type Chain = (typeof SUPPORTED_CHAINS)[number];

const MAX_AMOUNT_USD = 1_000_000;
const MIN_AMOUNT_USD = 0.01;
const DEFAULT_TTL_SECONDS = 900;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const MAX_METADATA_BYTES = 4 * 1024;

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  res.status(400).json({ error: { code, message } } satisfies ErrorBody);
}

function isSupportedChain(value: unknown): value is Chain {
  return typeof value === 'string' && (SUPPORTED_CHAINS as readonly string[]).includes(value);
}

function originFromRequest(req: VercelRequest): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'https';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  const hostStr = Array.isArray(host) ? host[0] : host;
  return hostStr ? `${proto}://${hostStr}` : 'https://zettapay.io';
}

/**
 * Deterministic mock receive address — until the Z45 HD allocator is wired in
 * as a service binding, the API endpoint returns a stable derived placeholder
 * so SDK callers can integrate end-to-end. Real allocation happens on
 * settlement-side dequeue.
 */
function mockReceiveAddress(chain: Chain, invoiceId: string): string {
  const hash = createHash('sha256').update(`${chain}:${invoiceId}`).digest();
  if (chain === 'btc') {
    const hex = hash.subarray(0, 20).toString('hex');
    return `bc1q${hex}`;
  }
  const hex = hash.subarray(0, 20).toString('hex');
  return `0x${hex}`;
}

/** USD → native amount placeholder. Real spot conversion happens in the listener at confirm-time. */
function nativeAmountFor(chain: Chain, amountUsd: number): string {
  if (chain === 'btc') {
    return (amountUsd / 65_000).toFixed(8);
  }
  return amountUsd.toFixed(2);
}

function explorerUrlFor(chain: Chain, address: string): string {
  switch (chain) {
    case 'btc':
      return `https://mempool.space/address/${address}`;
    case 'base':
      return `https://basescan.org/address/${address}`;
    case 'polygon':
      return `https://polygonscan.com/address/${address}`;
    case 'ethereum':
      return `https://etherscan.io/address/${address}`;
  }
}

function buildQrUri(chain: Chain, address: string, amountNative: string): string {
  if (chain === 'btc') {
    return `bitcoin:${address}?amount=${amountNative}`;
  }
  return `ethereum:${address}@${chainId(chain)}?value=${amountNative}`;
}

function chainId(chain: Chain): number {
  switch (chain) {
    case 'base':
      return 8453;
    case 'polygon':
      return 137;
    case 'ethereum':
      return 1;
    default:
      return 0;
  }
}

function readBody(req: VercelRequest): Record<string, unknown> {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try {
      const parsed = JSON.parse(req.body) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: SERVICE,
      runtime: RUNTIME,
      endpoint: '/api/invoices',
      method: 'POST',
      description:
        'Create a multi-chain invoice. ZettaPay watches the chain and fires a webhook on confirmation.',
      requestBody: {
        merchant: 'string (optional, merchant ref; alias for merchant_id)',
        merchant_id: 'string (optional, resolved from API key when omitted)',
        amount_usd: 'number (required, positive, ≤1,000,000)',
        chain: `enum: ${SUPPORTED_CHAINS.join(' | ')}`,
        ttl_seconds: `number (optional, 60..${MAX_TTL_SECONDS}, default ${DEFAULT_TTL_SECONDS})`,
        metadata: 'object (optional, ≤4KB serialized)',
      },
      supportedChains: SUPPORTED_CHAINS,
      fees: { rate: '0.30%', settlement: 'instant' },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = readBody(req);

  const chain = body.chain;
  if (typeof chain !== 'string' || chain.length === 0) {
    badRequest(res, 'missing_chain', 'Field "chain" is required');
    return;
  }
  if (!isSupportedChain(chain)) {
    badRequest(
      res,
      'invalid_chain',
      `Field "chain" must be one of ${SUPPORTED_CHAINS.join(', ')} (got "${chain}")`,
    );
    return;
  }

  const amountUsdRaw = body.amount_usd;
  const amountUsd = typeof amountUsdRaw === 'number' ? amountUsdRaw : Number(amountUsdRaw);
  if (!Number.isFinite(amountUsd) || amountUsd < MIN_AMOUNT_USD || amountUsd > MAX_AMOUNT_USD) {
    badRequest(
      res,
      'invalid_amount',
      `Field "amount_usd" must be a number in [${MIN_AMOUNT_USD}, ${MAX_AMOUNT_USD}]`,
    );
    return;
  }

  let ttl = DEFAULT_TTL_SECONDS;
  if (body.ttl_seconds !== undefined && body.ttl_seconds !== null) {
    const t = Number(body.ttl_seconds);
    if (!Number.isFinite(t) || t < 60 || t > MAX_TTL_SECONDS) {
      badRequest(
        res,
        'invalid_ttl',
        `Field "ttl_seconds" must be in [60, ${MAX_TTL_SECONDS}]`,
      );
      return;
    }
    ttl = Math.floor(t);
  }

  let merchantId: string | undefined;
  const merchantField = body.merchant_id ?? body.merchant;
  if (merchantField !== undefined && merchantField !== null) {
    if (typeof merchantField !== 'string' || merchantField.length === 0 || merchantField.length > 64) {
      badRequest(res, 'invalid_merchant_id', 'Field "merchant_id" must be a string of 1..64 chars');
      return;
    }
    merchantId = merchantField;
  }

  let metadata: Record<string, unknown> | undefined;
  if (body.metadata !== undefined && body.metadata !== null) {
    if (typeof body.metadata !== 'object' || Array.isArray(body.metadata)) {
      badRequest(res, 'invalid_metadata', 'Field "metadata" must be a JSON object');
      return;
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(body.metadata);
    } catch {
      badRequest(res, 'invalid_metadata', 'Field "metadata" must be JSON-serializable');
      return;
    }
    if (Buffer.byteLength(serialized, 'utf8') > MAX_METADATA_BYTES) {
      badRequest(res, 'metadata_too_large', `Field "metadata" must be ≤${MAX_METADATA_BYTES} bytes`);
      return;
    }
    metadata = body.metadata as Record<string, unknown>;
  }

  const invoiceId = `inv_${randomBytes(16).toString('hex')}`;
  const receiveAddress = mockReceiveAddress(chain, invoiceId);
  const amountNative = nativeAmountFor(chain, amountUsd);
  const nowSec = Math.floor(Date.now() / 1000);
  const origin = originFromRequest(req);

  res.status(201).json({
    invoice_id: invoiceId,
    chain,
    receive_address: receiveAddress,
    amount_usd: amountUsd,
    amount_native: amountNative,
    qr_uri: buildQrUri(chain, receiveAddress, amountNative),
    expires_at: nowSec + ttl,
    status: 'pending',
    verify_url: explorerUrlFor(chain, receiveAddress),
    merchant_id: merchantId,
    metadata,
    self: `${origin}/api/invoices/${invoiceId}`,
  });
}
