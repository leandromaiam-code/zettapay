import type { VercelRequest, VercelResponse } from '@vercel/node';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

function pickQuery(query: VercelRequest['query'], key: string): string | undefined {
  const raw = query[key];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

function parseInteger(
  raw: string | undefined,
  field: string,
  min: number,
  max: number,
): { value: number; error?: undefined } | { value?: undefined; error: string } {
  if (raw === undefined) return { value: NaN };
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    return { error: `${field} must be an integer` };
  }
  if (parsed < min || parsed > max) {
    return { error: `${field} must be between ${min} and ${max}` };
  }
  return { value: parsed };
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const limitRaw = pickQuery(req.query, 'limit');
  const offsetRaw = pickQuery(req.query, 'offset');

  const limitResult = parseInteger(limitRaw, 'limit', 1, MAX_LIMIT);
  if (limitResult.error) {
    badRequest(res, 'invalid_limit', limitResult.error);
    return;
  }
  const limit = Number.isFinite(limitResult.value) ? (limitResult.value as number) : DEFAULT_LIMIT;

  const offsetResult = parseInteger(offsetRaw, 'offset', 0, 1_000_000);
  if (offsetResult.error) {
    badRequest(res, 'invalid_offset', offsetResult.error);
    return;
  }
  const offset = Number.isFinite(offsetResult.value) ? (offsetResult.value as number) : 0;

  res.status(200).json({
    service: SERVICE,
    runtime: RUNTIME,
    endpoint: '/api/payments',
    method: 'GET',
    description:
      'List payments in reverse chronological order. Edge handler returns the contract envelope; persistent reads are served by the @zettapay/api backend.',
    query: {
      limit: `integer (1-${MAX_LIMIT}, default ${DEFAULT_LIMIT})`,
      offset: 'integer (≥0)',
    },
    pagination: { limit, offset },
    items: [],
    count: 0,
    total: 0,
    network: 'solana-devnet',
  });
}
