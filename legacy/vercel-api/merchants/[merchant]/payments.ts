import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../../_lib/base58.js';
import { normalizeMerchantId } from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

const NETWORK = 'solana-devnet';
const USDC_MINT = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function pickQuery(query: VercelRequest['query'], key: string): string | undefined {
  const raw = query[key];
  if (Array.isArray(raw)) return raw[0];
  return typeof raw === 'string' ? raw : undefined;
}

function deterministicBytes(seed: string, len: number): Buffer {
  let out = Buffer.alloc(0);
  let counter = 0;
  while (out.length < len) {
    out = Buffer.concat([out, createHash('sha256').update(`${seed}:${counter}`).digest()]);
    counter++;
  }
  return out.subarray(0, len);
}

function deterministicPubkey(seed: string): string {
  return base58Encode(deterministicBytes(seed, 32));
}

function deterministicSignature(seed: string): string {
  return base58Encode(deterministicBytes(seed, 64));
}

interface PaymentRow {
  id: string;
  amountUsdc: number;
  payerWallet: string;
  status: 'completed' | 'pending' | 'failed';
  txSignature: string | null;
  acceptedAt: string;
  completedAt: string | null;
  explorerUrl: string | null;
  currency: 'USDC';
}

function buildSyntheticPayments(merchantId: string, limit: number): PaymentRow[] {
  const epochDay = Math.floor(Date.now() / 86_400_000);
  const items: PaymentRow[] = [];
  for (let i = 0; i < limit; i++) {
    const seed = `${merchantId}:${epochDay}:${i}`;
    const seedBytes = createHash('sha256').update(seed).digest();
    const minutesAgo = (seedBytes.readUInt16BE(0) % 1440) + i * 7;
    const acceptedAt = new Date(Date.now() - minutesAgo * 60_000);
    const cents = (seedBytes.readUInt32BE(2) % 49_900) + 100;
    const amountUsdc = Math.round(cents) / 100;
    const statusByte = seedBytes[6] ?? 0;
    let status: PaymentRow['status'] = 'completed';
    if (statusByte > 240) status = 'pending';
    else if (statusByte > 230) status = 'failed';

    const id = 'pay_' + base58Encode(seedBytes.subarray(8, 20));
    const payerWallet = deterministicPubkey(`payer:${seed}`);
    const txSignature = status === 'completed' ? deterministicSignature(`sig:${seed}`) : null;
    const completedAt =
      status === 'completed'
        ? new Date(acceptedAt.getTime() + ((seedBytes.readUInt16BE(20) % 60) + 1) * 1000).toISOString()
        : null;

    items.push({
      id,
      amountUsdc,
      payerWallet,
      status,
      txSignature,
      acceptedAt: acceptedAt.toISOString(),
      completedAt,
      explorerUrl: txSignature ? `https://explorer.solana.com/tx/${txSignature}?cluster=devnet` : null,
      currency: 'USDC',
    });
  }
  items.sort((a, b) => (a.acceptedAt < b.acceptedAt ? 1 : -1));
  return items;
}

export default function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const merchantId = normalizeMerchantId(req.query.merchant);
  if (!merchantId) {
    fail(res, 400, 'invalid_merchant', 'Path param "merchant" is required');
    return;
  }

  const auth = req.headers.authorization;
  const session = verifySession(auth);
  if (!session) {
    fail(res, 401, 'unauthorized', 'Bearer dashboard session token required');
    return;
  }
  if (session.merchant !== merchantId) {
    fail(res, 403, 'forbidden', 'Session does not match merchant in path');
    return;
  }

  const limitRaw = pickQuery(req.query, 'limit');
  let limit = DEFAULT_LIMIT;
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
      fail(res, 400, 'invalid_limit', `limit must be 1..${MAX_LIMIT}`);
      return;
    }
    limit = parsed;
  }

  const items = buildSyntheticPayments(merchantId, limit);
  const completedSum = items
    .filter((p) => p.status === 'completed')
    .reduce((s, p) => s + p.amountUsdc, 0);

  res.status(200).json({
    merchant: merchantId,
    network: NETWORK,
    currency: 'USDC',
    mint: USDC_MINT,
    pagination: { limit, total: items.length },
    summary: {
      totalCount: items.length,
      completedCount: items.filter((p) => p.status === 'completed').length,
      pendingCount: items.filter((p) => p.status === 'pending').length,
      failedCount: items.filter((p) => p.status === 'failed').length,
      completedAmountUsdc: Math.round(completedSum * 100) / 100,
    },
    items,
  });
}
