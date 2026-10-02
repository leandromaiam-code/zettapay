import { randomBytes } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from './_lib/base58.js';
import { withSentry } from './_lib/sentry.js';

const SERVICE = 'zettapay';
const RUNTIME = 'vercel-serverless';
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const USDC_DEVNET_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';

const USDC_AMOUNT = 1000;
const USDC_DECIMALS = 6;
const SOL_AIRDROP_LAMPORTS = 1_000_000_000;
const COOLDOWN_MS = 60 * 60 * 1000;
const MAX_BUCKET_KEYS = 10_000;

interface BucketEntry {
  lastFulfilledAt: number;
}

const buckets = new Map<string, BucketEntry>();

function pruneBuckets(now: number): void {
  if (buckets.size <= MAX_BUCKET_KEYS) return;
  for (const [key, entry] of buckets) {
    if (now - entry.lastFulfilledAt >= COOLDOWN_MS) buckets.delete(key);
    if (buckets.size <= MAX_BUCKET_KEYS / 2) break;
  }
}

export interface FaucetGateResult {
  allowed: boolean;
  remainingMs: number;
  resetAtMs: number;
}

export function evaluateFaucetGate(
  recipient: string,
  now: number,
  store: Map<string, BucketEntry> = buckets,
): FaucetGateResult {
  const entry = store.get(recipient);
  if (!entry) {
    return { allowed: true, remainingMs: 0, resetAtMs: now };
  }
  const elapsed = now - entry.lastFulfilledAt;
  if (elapsed >= COOLDOWN_MS) {
    return { allowed: true, remainingMs: 0, resetAtMs: now };
  }
  const remainingMs = COOLDOWN_MS - elapsed;
  return {
    allowed: false,
    remainingMs,
    resetAtMs: entry.lastFulfilledAt + COOLDOWN_MS,
  };
}

export function recordFaucetFulfillment(
  recipient: string,
  now: number,
  store: Map<string, BucketEntry> = buckets,
): void {
  store.set(recipient, { lastFulfilledAt: now });
  pruneBuckets(now);
}

interface RpcAirdropResult {
  signature: string | null;
  error: string | null;
}

async function requestSolAirdrop(
  recipient: string,
  lamports: number,
  rpcUrl: string,
): Promise<RpcAirdropResult> {
  try {
    const response = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'requestAirdrop',
        params: [recipient, lamports],
      }),
    });
    if (!response.ok) {
      return { signature: null, error: `rpc_http_${response.status}` };
    }
    const body = (await response.json()) as {
      result?: string;
      error?: { message?: string };
    };
    if (body.error) {
      return { signature: null, error: body.error.message ?? 'rpc_error' };
    }
    return { signature: body.result ?? null, error: null };
  } catch (err) {
    return {
      signature: null,
      error: err instanceof Error ? err.message : 'unknown_rpc_error',
    };
  }
}

function simulatedSignature(): string {
  return base58Encode(randomBytes(64));
}

function applyRateLimitHeaders(
  res: VercelResponse,
  remaining: number,
  resetAtMs: number,
): void {
  res.setHeader('X-RateLimit-Limit', '1');
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  res.setHeader('X-RateLimit-Reset', String(Math.ceil(resetAtMs / 1000)));
}

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.status(204).end();
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' || req.method === 'HEAD') {
    res.status(200).json({
      service: SERVICE,
      runtime: RUNTIME,
      endpoint: '/api/faucet',
      description:
        'Devnet developer faucet. Dispenses 1000 USDC (devnet mint) per recipient per hour and a 1 SOL airdrop for rent and gas. Devnet only — never returns funds with mainnet value.',
      network: 'solana-devnet',
      currency: 'USDC',
      mintAddress: USDC_DEVNET_MINT,
      amount: USDC_AMOUNT,
      decimals: USDC_DECIMALS,
      cooldownSeconds: COOLDOWN_MS / 1000,
      solAirdropLamports: SOL_AIRDROP_LAMPORTS,
      circleFaucetUrl: CIRCLE_FAUCET_URL,
      embedUrl: '/docs/faucet',
      method: 'POST',
      requestBody: {
        recipient: 'string (required, base58 Solana pubkey)',
      },
      example: {
        request: {
          method: 'POST',
          url: 'https://api.zettapay.io/api/faucet',
          body: { recipient: '<your-phantom-pubkey>' },
        },
      },
    });
    return;
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
    res
      .status(405)
      .json({ error: { code: 'method_not_allowed', message: 'POST or GET only' } });
    return;
  }

  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<
    string,
    unknown
  >;
  const recipient = typeof body.recipient === 'string' ? body.recipient.trim() : '';
  if (!recipient || !SOLANA_ADDRESS_RE.test(recipient)) {
    res.status(400).json({
      error: {
        code: 'invalid_recipient',
        message: 'Field "recipient" is required and must be a base58 Solana pubkey',
      },
    });
    return;
  }

  const now = Date.now();
  const gate = evaluateFaucetGate(recipient, now);
  if (!gate.allowed) {
    applyRateLimitHeaders(res, 0, gate.resetAtMs);
    res.setHeader('Retry-After', String(Math.ceil(gate.remainingMs / 1000)));
    res.status(429).json({
      error: {
        code: 'rate_limited',
        message:
          'Faucet quota exhausted. Each recipient can claim 1000 USDC devnet once per hour.',
        retryAfterMs: gate.remainingMs,
        resetAt: new Date(gate.resetAtMs).toISOString(),
      },
    });
    return;
  }

  const rpcUrl = process.env.SOLANA_RPC_URL?.trim() || DEFAULT_RPC_URL;
  const network = process.env.SOLANA_NETWORK?.trim() || 'devnet';
  if (network === 'mainnet-beta') {
    res.status(409).json({
      error: {
        code: 'faucet_unavailable',
        message: 'Faucet is devnet-only. Mainnet airdrops are never issued.',
      },
    });
    return;
  }

  const sol = await requestSolAirdrop(recipient, SOL_AIRDROP_LAMPORTS, rpcUrl);
  recordFaucetFulfillment(recipient, now);
  applyRateLimitHeaders(res, 0, now + COOLDOWN_MS);

  res.status(200).json({
    status: 'fulfilled',
    network,
    recipient,
    cooldownSeconds: COOLDOWN_MS / 1000,
    nextEligibleAt: new Date(now + COOLDOWN_MS).toISOString(),
    sol: {
      lamports: SOL_AIRDROP_LAMPORTS,
      signature: sol.signature,
      mode: sol.signature ? 'live' : 'unavailable',
      error: sol.error,
      explorer: sol.signature
        ? `https://explorer.solana.com/tx/${sol.signature}?cluster=devnet`
        : null,
    },
    usdc: {
      amount: USDC_AMOUNT,
      decimals: USDC_DECIMALS,
      mintAddress: USDC_DEVNET_MINT,
      mode: 'simulated',
      signature: simulatedSignature(),
      hint:
        'For real devnet USDC balance, redeem the quota at faucet.circle.com using the same recipient wallet — Circle is the canonical USDC devnet issuer.',
      circleFaucetUrl: CIRCLE_FAUCET_URL,
    },
  });
}

export default withSentry(handler);
