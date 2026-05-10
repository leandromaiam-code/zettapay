import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  deterministicWallet,
  normalizeMerchantId,
  validateAllowedOrigins,
  validateWebhookUrl,
} from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

const NETWORK = 'solana-devnet';

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

interface SettingsResponse {
  merchant: string;
  walletAddress: string;
  network: string;
  webhookUrl: string | null;
  webhookSecretFingerprint: string | null;
  allowedOrigins: string[];
  updatedAt: string;
  updated: boolean;
}

function fingerprint(merchantId: string): string {
  return 'whsec_' +
    createHash('sha256').update(`zettapay:webhook:${merchantId}`).digest('hex').slice(0, 16);
}

function buildResponse(
  merchantId: string,
  webhookUrl: string | null,
  allowedOrigins: string[],
  updated: boolean,
): SettingsResponse {
  return {
    merchant: merchantId,
    walletAddress: deterministicWallet(merchantId),
    network: NETWORK,
    webhookUrl,
    webhookSecretFingerprint: webhookUrl ? fingerprint(merchantId) : null,
    allowedOrigins,
    updatedAt: new Date().toISOString(),
    updated,
  };
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  const merchantId = normalizeMerchantId(req.query.merchant);
  if (!merchantId) {
    fail(res, 400, 'invalid_merchant', 'Path param "merchant" is required');
    return;
  }

  if (req.method !== 'GET' && req.method !== 'PATCH' && req.method !== 'POST' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, PATCH, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET or PATCH' } });
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

  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json(buildResponse(merchantId, null, [], false));
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  const webhookCheck = validateWebhookUrl(body.webhookUrl);
  if (!webhookCheck.ok) {
    fail(res, 400, 'invalid_webhook_url', webhookCheck.message);
    return;
  }

  const originsCheck = validateAllowedOrigins(body.allowedOrigins);
  if (!originsCheck.ok) {
    fail(res, 400, 'invalid_allowed_origins', originsCheck.message);
    return;
  }

  res.status(200).json(buildResponse(merchantId, webhookCheck.value, originsCheck.value, true));
}
