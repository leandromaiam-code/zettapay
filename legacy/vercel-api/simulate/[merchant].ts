import { randomBytes, createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../_lib/base58.js';
import { withSentry } from '../_lib/sentry.js';

const SIMULATE_NETWORK = 'solana-devnet';
const SIMULATE_USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const SIMULATE_DISCLAIMER =
  'Hackathon demo simulator — no real money is moved on Solana devnet or mainnet.';

const DEFAULT_AIRDROP_USDC = 100;
const DEFAULT_PAYMENT_USDC = 1;
const MIN_AMOUNT = 0.000001;
const MAX_AMOUNT = 1_000_000;

function fakeSignature(): string {
  return base58Encode(randomBytes(64));
}

function fakeBlockhash(): string {
  return base58Encode(randomBytes(32));
}

function deterministicPubkey(seed: string): string {
  return base58Encode(createHash('sha256').update(seed).digest());
}

function toMicroUsdc(amount: number): string {
  return Math.round(amount * 1_000_000).toString();
}

function parseAmount(raw: unknown, fallback: number): number | null {
  if (raw === undefined) return fallback;
  if (Array.isArray(raw)) raw = raw[0];
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < MIN_AMOUNT || value > MAX_AMOUNT) return null;
  return value;
}

function normalizeMerchantRef(raw: unknown): string | null {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function paymentId(): string {
  return `pay_${base58Encode(randomBytes(12))}`;
}

function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const merchantRef = normalizeMerchantRef(req.query.merchant);
  if (!merchantRef) {
    res.status(400).json({
      error: { code: 'invalid_merchant', message: 'invalid merchant reference' },
    });
    return;
  }

  const airdropAmount = parseAmount(req.query.airdrop, DEFAULT_AIRDROP_USDC);
  const paymentAmount = parseAmount(req.query.amount, DEFAULT_PAYMENT_USDC);
  if (airdropAmount === null || paymentAmount === null) {
    res.status(400).json({
      error: { code: 'invalid_amount', message: 'invalid airdrop or amount query' },
    });
    return;
  }

  const merchantWallet = deterministicPubkey(`zettapay:merchant:wallet:${merchantRef}`);
  const merchantAta = deterministicPubkey(`zettapay:merchant:ata:${merchantRef}`);
  const payerPubkey = deterministicPubkey(`zettapay:payer:${merchantRef}:${Date.now()}`);
  const airdropSignature = fakeSignature();
  const paymentSignature = fakeSignature();
  const blockhash = fakeBlockhash();
  const acceptedAt = new Date().toISOString();

  const merchant = {
    id: merchantRef,
    handle: `@${merchantRef}`,
    walletAddress: merchantWallet,
    ataAddress: merchantAta,
    status: 'active',
  };

  res.status(200).json({
    simulated: true,
    network: SIMULATE_NETWORK,
    disclaimer: SIMULATE_DISCLAIMER,
    merchant,
    airdrop: {
      recipient: merchantAta,
      amount: airdropAmount,
      amountMicroUsdc: toMicroUsdc(airdropAmount),
      currency: 'USDC',
      mint: SIMULATE_USDC_MINT,
      signature: airdropSignature,
    },
    payment: {
      id: paymentId(),
      from: payerPubkey,
      to: merchantAta,
      amount: paymentAmount,
      amountMicroUsdc: toMicroUsdc(paymentAmount),
      currency: 'USDC',
      mint: SIMULATE_USDC_MINT,
      signature: paymentSignature,
      recentBlockhash: blockhash,
      acceptedAt,
    },
  });
}

export default withSentry(handler);
