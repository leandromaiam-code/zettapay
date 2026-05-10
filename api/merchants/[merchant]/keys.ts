import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  deterministicApiKey,
  deterministicSecretKey,
  freshApiKey,
  freshSecretKey,
  maskKey,
  normalizeMerchantId,
} from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

interface KeysResponse {
  merchant: string;
  apiKey: { value: string; masked: string; createdAt: string };
  secretKey: { value: string; masked: string; createdAt: string } | null;
  rotated: boolean;
  warning?: string;
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  const merchantId = normalizeMerchantId(req.query.merchant);
  if (!merchantId) {
    fail(res, 400, 'invalid_merchant', 'Path param "merchant" is required');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET or POST' } });
    return;
  }

  const session = verifySession(req.headers.authorization);
  if (!session) {
    fail(res, 401, 'unauthorized', 'Bearer dashboard session token required');
    return;
  }
  if (session.merchant !== merchantId) {
    fail(res, 403, 'forbidden', 'Session does not match merchant in path');
    return;
  }

  if (req.method === 'POST') {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'reveal';

    if (action === 'rotate') {
      const apiKey = freshApiKey();
      const secretKey = freshSecretKey();
      const now = new Date().toISOString();
      const payload: KeysResponse = {
        merchant: merchantId,
        apiKey: { value: apiKey, masked: maskKey(apiKey), createdAt: now },
        secretKey: { value: secretKey, masked: maskKey(secretKey), createdAt: now },
        rotated: true,
        warning:
          'Old keys are revoked immediately. Replace them in your server config — webhooks signed with the previous secret will start failing now.',
      };
      res.status(200).json(payload);
      return;
    }

    if (action !== 'reveal') {
      fail(res, 400, 'invalid_action', 'Field "action" must be "reveal" or "rotate"');
      return;
    }
    // fall through to reveal
  }

  const apiKey = deterministicApiKey(merchantId);
  const secretKey = deterministicSecretKey(merchantId);
  const createdAt = new Date(session.issuedAt).toISOString();
  const wantSecret = req.method === 'POST'; // explicit reveal
  const payload: KeysResponse = {
    merchant: merchantId,
    apiKey: { value: apiKey, masked: maskKey(apiKey), createdAt },
    secretKey: wantSecret
      ? { value: secretKey, masked: maskKey(secretKey), createdAt }
      : { value: maskKey(secretKey), masked: maskKey(secretKey), createdAt },
    rotated: false,
  };
  res.status(200).json(payload);
}
