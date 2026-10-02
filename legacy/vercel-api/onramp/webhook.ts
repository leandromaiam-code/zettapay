import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const SIGNATURE_HEADER = 'moonpay-signature-v2';
const DEFAULT_TOLERANCE_MS = 5 * 60 * 1_000;
const COMPLETION_EVENT = 'transaction_updated';
const COMPLETED_STATUS = 'completed';

type ErrorBody = { error: { code: string; message: string } };

function reject(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

function rawBodyBuffer(req: VercelRequest): Buffer {
  const body = req.body as unknown;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body && typeof body === 'object') return Buffer.from(JSON.stringify(body), 'utf8');
  return Buffer.alloc(0);
}

function parseSignatureHeader(header: string): { timestamp: string; signature: string } | null {
  let timestamp: string | undefined;
  let signature: string | undefined;
  for (const part of header.split(',').map((p) => p.trim())) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 's') signature = value;
  }
  if (!timestamp || !signature) return null;
  return { timestamp, signature };
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: 'zettapay',
      runtime: 'vercel-serverless',
      endpoint: '/api/onramp/webhook',
      method: 'POST',
      description:
        'MoonPay onramp webhook receiver. Verifies HMAC-SHA256 signature against MOONPAY_WEBHOOK_SECRET and acknowledges transaction_updated/completed events.',
      headers: { [SIGNATURE_HEADER]: 't=<epoch_ms>,s=<hex>' },
      events: [`${COMPLETION_EVENT} (status=${COMPLETED_STATUS})`],
      configured: Boolean(process.env.MOONPAY_WEBHOOK_SECRET),
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST only' } });
    return;
  }

  const secret = process.env.MOONPAY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    reject(res, 503, 'onramp_disabled', 'onramp webhook secret not configured');
    return;
  }

  const signatureHeaderRaw = req.headers[SIGNATURE_HEADER];
  const signatureHeader = Array.isArray(signatureHeaderRaw)
    ? signatureHeaderRaw[0]
    : signatureHeaderRaw;
  if (!signatureHeader) {
    reject(res, 401, 'missing_signature', `${SIGNATURE_HEADER} header is required`);
    return;
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    reject(res, 401, 'invalid_signature_format', 'signature header must contain t=<ts>,s=<hex>');
    return;
  }

  const timestampNum = Number.parseInt(parsed.timestamp, 10);
  if (!Number.isFinite(timestampNum)) {
    reject(res, 401, 'invalid_signature_format', 'signature timestamp must be numeric epoch ms');
    return;
  }

  const skew = Math.abs(Date.now() - timestampNum);
  if (skew > DEFAULT_TOLERANCE_MS) {
    reject(
      res,
      401,
      'expired_signature',
      `signature timestamp drift ${skew}ms exceeds ${DEFAULT_TOLERANCE_MS}ms`,
    );
    return;
  }

  const rawBody = rawBodyBuffer(req);
  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.`)
    .update(rawBody)
    .digest('hex');

  if (!safeEqualHex(expected, parsed.signature)) {
    reject(res, 401, 'invalid_signature', 'signature digest does not match payload');
    return;
  }

  let payload: { type?: unknown; data?: { status?: unknown; id?: unknown; externalTransactionId?: unknown } };
  try {
    payload = JSON.parse(rawBody.toString('utf8') || 'null');
  } catch {
    reject(res, 400, 'invalid_json', 'request body is not valid JSON');
    return;
  }

  if (!payload || typeof payload !== 'object') {
    reject(res, 400, 'invalid_payload', 'webhook payload must be an object');
    return;
  }

  if (payload.type !== COMPLETION_EVENT) {
    res.status(200).json({ accepted: true, ignored: true, reason: 'unsupported_event' });
    return;
  }

  if (payload.data?.status !== COMPLETED_STATUS) {
    res.status(200).json({ accepted: true, ignored: true, reason: 'incomplete_status' });
    return;
  }

  const externalIdRaw =
    typeof payload.data.externalTransactionId === 'string'
      ? payload.data.externalTransactionId
      : typeof payload.data.id === 'string'
        ? payload.data.id
        : null;

  if (!externalIdRaw) {
    reject(res, 400, 'invalid_payload', 'webhook is missing data.id or data.externalTransactionId');
    return;
  }

  res.status(200).json({
    accepted: true,
    ignored: false,
    externalTransactionId: externalIdRaw,
    note:
      'Edge handler acknowledged. Persistence + downstream webhook fan-out happen in the @zettapay/api worker.',
  });
}
