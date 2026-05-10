import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  base58Decode,
  buildChallengeMessage,
  issueSession,
  verifyChallengeToken,
  verifyEd25519,
} from '../../_lib/session.js';
import { hostFromRequest } from '../../_lib/merchant.js';

const NETWORK = 'solana-devnet';

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function decodeSignature(raw: unknown): Buffer | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (/^[0-9a-fA-F]+$/.test(raw) && raw.length === 128) {
    return Buffer.from(raw, 'hex');
  }
  if (/^[A-Za-z0-9+/]+=*$/.test(raw)) {
    try {
      const buf = Buffer.from(raw, 'base64');
      if (buf.length === 64) return buf;
    } catch {
      // fall through
    }
  }
  const b58 = base58Decode(raw);
  if (b58 && b58.length === 64) return b58;
  return null;
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      endpoint: '/api/merchants/auth/verify',
      method: 'POST',
      description:
        'Verify an ed25519 signature over a challenge issued by /api/merchants/auth/challenge. Returns a short-lived dashboard session token (HMAC-signed, 30 min TTL).',
      requestBody: {
        challengeToken: 'string (required, returned by /challenge)',
        signature: 'string (required, base58 / hex / base64 — 64 bytes)',
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'POST only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

  const challengeToken = typeof body.challengeToken === 'string' ? body.challengeToken : '';
  if (!challengeToken) {
    fail(res, 400, 'missing_challenge_token', 'Field "challengeToken" is required');
    return;
  }
  const challenge = verifyChallengeToken(challengeToken);
  if (!challenge) {
    fail(res, 401, 'invalid_challenge', 'Challenge token is invalid or expired (5 min TTL)');
    return;
  }

  const signature = decodeSignature(body.signature);
  if (!signature) {
    fail(res, 400, 'invalid_signature', 'Field "signature" must be 64 bytes (base58 / hex / base64)');
    return;
  }

  const pubkey = base58Decode(challenge.wallet);
  if (!pubkey || pubkey.length !== 32) {
    fail(res, 400, 'invalid_wallet_pubkey', 'Challenge wallet is not a valid base58 pubkey');
    return;
  }

  const host = hostFromRequest(req);
  const message = buildChallengeMessage(challenge, host, NETWORK);
  const ok = verifyEd25519(Buffer.from(message, 'utf8'), signature, pubkey);
  if (!ok) {
    fail(res, 401, 'signature_mismatch', 'Signature does not verify for the issued challenge');
    return;
  }

  const session = issueSession(challenge.merchant, challenge.wallet);
  res.status(200).json({
    session: {
      token: session.token,
      expiresAt: new Date(session.expiresAt).toISOString(),
      merchant: challenge.merchant,
      wallet: challenge.wallet,
      tokenType: 'Bearer',
    },
  });
}
