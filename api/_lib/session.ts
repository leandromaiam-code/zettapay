import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify, randomBytes } from 'node:crypto';

const DEFAULT_DEV_SECRET = 'zettapay-dashboard-dev-secret-change-in-prod';
const SESSION_TTL_MS = 30 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function sessionSecret(): string {
  const env = process.env.ZETTAPAY_DASHBOARD_SECRET || process.env.MERCHANT_WEBHOOK_SECRET;
  return env && env.length > 0 ? env : DEFAULT_DEV_SECRET;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(norm, 'base64');
}

export interface ChallengePayload {
  wallet: string;
  merchant: string;
  nonce: string;
  issuedAt: number;
}

export function buildChallengeMessage(p: ChallengePayload, host: string, network: string): string {
  return [
    'Sign in to ZettaPay merchant dashboard.',
    '',
    `Merchant: ${p.merchant}`,
    `Wallet: ${p.wallet}`,
    `Nonce: ${p.nonce}`,
    `Issued at: ${new Date(p.issuedAt).toISOString()}`,
    `Domain: ${host}`,
    `Network: ${network}`,
  ].join('\n');
}

export function signChallenge(p: ChallengePayload): string {
  const body = b64url(Buffer.from(JSON.stringify(p), 'utf8'));
  const sig = b64url(createHmac('sha256', sessionSecret()).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyChallengeToken(token: string): ChallengePayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionSecret()).update(body).digest();
  const provided = b64urlDecode(sig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as ChallengePayload;
    if (Date.now() - payload.issuedAt > CHALLENGE_TTL_MS) return null;
    return payload;
  } catch {
    return null;
  }
}

export interface SessionPayload {
  merchant: string;
  wallet: string;
  issuedAt: number;
  expiresAt: number;
}

export function issueSession(merchant: string, wallet: string): { token: string; expiresAt: number } {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + SESSION_TTL_MS;
  const payload: SessionPayload = { merchant, wallet, issuedAt, expiresAt };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = b64url(createHmac('sha256', sessionSecret()).update(body).digest());
  return { token: `${body}.${sig}`, expiresAt };
}

export function verifySession(token: string | undefined | string[]): SessionPayload | null {
  const raw = Array.isArray(token) ? token[0] : token;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const value = raw.startsWith('Bearer ') ? raw.slice(7) : raw;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  if (!body || !sig) return null;
  const expected = createHmac('sha256', sessionSecret()).update(body).digest();
  const provided = b64urlDecode(sig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8')) as SessionPayload;
    if (Date.now() > payload.expiresAt) return null;
    return payload;
  } catch {
    return null;
  }
}

export function freshNonce(): string {
  return b64url(randomBytes(18));
}

const BS58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BS58_INDEX = new Map<string, number>();
for (let i = 0; i < BS58_ALPHABET.length; i++) BS58_INDEX.set(BS58_ALPHABET[i] as string, i);

export function base58Decode(s: string): Buffer | null {
  if (s.length === 0) return Buffer.alloc(0);
  const digits = [0];
  for (const ch of s) {
    const v = BS58_INDEX.get(ch);
    if (v === undefined) return null;
    let carry = v;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) * 58;
      digits[j] = carry & 0xff;
      carry >>>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>>= 8;
    }
  }
  let leadingZeros = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    leadingZeros++;
  }
  const out = Buffer.alloc(leadingZeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[leadingZeros + i] = digits[digits.length - 1 - i] ?? 0;
  return out;
}

const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function verifyEd25519(message: Buffer, signature: Buffer, pubkey: Buffer): boolean {
  if (pubkey.length !== 32 || signature.length !== 64) return false;
  try {
    const der = Buffer.concat([ED25519_DER_PREFIX, pubkey]);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
