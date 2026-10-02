import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  buildChallengeMessage,
  freshNonce,
  signChallenge,
  type ChallengePayload,
} from '../../_lib/session.js';
import { hostFromRequest, isValidWallet, normalizeMerchantId } from '../../_lib/merchant.js';

const NETWORK = 'solana-devnet';

type ErrorBody = { error: { code: string; message: string } };

function badRequest(res: VercelResponse, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(400).json(body);
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      endpoint: '/api/merchants/auth/challenge',
      method: 'POST',
      description:
        'Issue a one-time challenge nonce for Phantom signature login. Sign the returned `message` with the wallet, then POST {wallet, merchant, signature, message, challengeToken} to /api/merchants/auth/verify.',
      requestBody: {
        wallet: 'string (required, base58 Solana pubkey)',
        merchant: 'string (required, merchant id)',
      },
      ttlSeconds: 300,
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  const merchant = normalizeMerchantId(body.merchant);
  if (!merchant) {
    badRequest(res, 'invalid_merchant', 'Field "merchant" is required');
    return;
  }

  if (!isValidWallet(body.wallet)) {
    badRequest(res, 'invalid_wallet', 'Field "wallet" must be a base58 Solana pubkey');
    return;
  }

  const payload: ChallengePayload = {
    wallet: body.wallet,
    merchant,
    nonce: freshNonce(),
    issuedAt: Date.now(),
  };
  const host = hostFromRequest(req);
  const message = buildChallengeMessage(payload, host, NETWORK);
  const challengeToken = signChallenge(payload);

  res.status(200).json({
    challenge: {
      wallet: payload.wallet,
      merchant: payload.merchant,
      nonce: payload.nonce,
      issuedAt: new Date(payload.issuedAt).toISOString(),
      expiresAt: new Date(payload.issuedAt + 5 * 60 * 1000).toISOString(),
      message,
      domain: host,
      network: NETWORK,
    },
    challengeToken,
  });
}
