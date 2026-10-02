import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../../_lib/base58.js';
import { normalizeMerchantId } from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

const NETWORK = 'solana-devnet';
const FEE_BPS = 30;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

// FX baseline used to render USD / BRL columns alongside the on-chain USDC
// settlement amount. USDC pegs 1:1 to USD; the BRL leg uses a conservative
// reference rate suitable for accounting drafts. Future Z11 work wires this
// to a live FX feed (e.g. Chainlink or Banco Central PTAX).
const USDC_TO_USD = 1.0;
const USD_TO_BRL = 5.05;

type SettlementStatus = 'pending' | 'processing' | 'completed' | 'failed';

interface SettlementRow {
  id: string;
  paymentId: string;
  status: SettlementStatus;
  amountUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  amountUsd: number;
  netUsd: number;
  amountBrl: number;
  netBrl: number;
  bankAccountId: string;
  withdrawalId: string | null;
  createdAt: string;
  completedAt: string | null;
}

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

function deterministicId(seed: string, prefix: string, byteLen: number): string {
  return prefix + base58Encode(deterministicBytes(seed, byteLen));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function buildSyntheticPayouts(merchantId: string, limit: number): SettlementRow[] {
  const epochDay = Math.floor(Date.now() / 86_400_000);
  const items: SettlementRow[] = [];
  for (let i = 0; i < limit; i++) {
    const seed = `${merchantId}:settlement:${epochDay}:${i}`;
    const seedBytes = createHash('sha256').update(seed).digest();
    const minutesAgo = (seedBytes.readUInt32BE(0) % (60 * 24 * 90)) + i * 47;
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    const cents = (seedBytes.readUInt32BE(4) % 199_900) + 500;
    const amountUsdc = round2(cents / 100);
    const feeUsdc = round2((amountUsdc * FEE_BPS) / 10_000);
    const netUsdc = round2(amountUsdc - feeUsdc);

    const statusByte = seedBytes[8] ?? 0;
    let status: SettlementStatus;
    if (statusByte > 248) status = 'failed';
    else if (statusByte > 240) status = 'pending';
    else if (statusByte > 232) status = 'processing';
    else status = 'completed';

    const completedAt =
      status === 'completed'
        ? new Date(createdAt.getTime() + ((seedBytes.readUInt16BE(9) % 240) + 30) * 1000).toISOString()
        : null;

    items.push({
      id: deterministicId(`${seed}:id`, 'st_', 12),
      paymentId: deterministicId(`${seed}:pay`, 'pay_', 12),
      status,
      amountUsdc,
      feeUsdc,
      netUsdc,
      amountUsd: round2(amountUsdc * USDC_TO_USD),
      netUsd: round2(netUsdc * USDC_TO_USD),
      amountBrl: round2(amountUsdc * USDC_TO_USD * USD_TO_BRL),
      netBrl: round2(netUsdc * USDC_TO_USD * USD_TO_BRL),
      bankAccountId: deterministicId(`${merchantId}:bank`, 'bank_', 8),
      withdrawalId:
        status === 'completed' ? deterministicId(`${seed}:wd`, 'wd_', 12) : null,
      createdAt: createdAt.toISOString(),
      completedAt,
    });
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

interface Summary {
  totalCount: number;
  completedCount: number;
  pendingCount: number;
  processingCount: number;
  failedCount: number;
  grossUsdc: number;
  feeUsdc: number;
  netUsdc: number;
  netUsd: number;
  netBrl: number;
}

function summarize(items: SettlementRow[]): Summary {
  let completedCount = 0;
  let pendingCount = 0;
  let processingCount = 0;
  let failedCount = 0;
  let grossUsdc = 0;
  let feeUsdc = 0;
  let netUsdc = 0;
  for (const r of items) {
    if (r.status === 'completed') completedCount++;
    else if (r.status === 'pending') pendingCount++;
    else if (r.status === 'processing') processingCount++;
    else failedCount++;
    if (r.status === 'completed') {
      grossUsdc += r.amountUsdc;
      feeUsdc += r.feeUsdc;
      netUsdc += r.netUsdc;
    }
  }
  return {
    totalCount: items.length,
    completedCount,
    pendingCount,
    processingCount,
    failedCount,
    grossUsdc: round2(grossUsdc),
    feeUsdc: round2(feeUsdc),
    netUsdc: round2(netUsdc),
    netUsd: round2(netUsdc * USDC_TO_USD),
    netBrl: round2(netUsdc * USDC_TO_USD * USD_TO_BRL),
  };
}

const CSV_COLUMNS: ReadonlyArray<{ key: keyof SettlementRow; header: string }> = [
  { key: 'id', header: 'settlement_id' },
  { key: 'paymentId', header: 'payment_id' },
  { key: 'status', header: 'status' },
  { key: 'amountUsdc', header: 'gross_usdc' },
  { key: 'feeUsdc', header: 'fee_usdc' },
  { key: 'netUsdc', header: 'net_usdc' },
  { key: 'amountUsd', header: 'gross_usd' },
  { key: 'netUsd', header: 'net_usd' },
  { key: 'amountBrl', header: 'gross_brl' },
  { key: 'netBrl', header: 'net_brl' },
  { key: 'bankAccountId', header: 'bank_account_id' },
  { key: 'withdrawalId', header: 'withdrawal_id' },
  { key: 'createdAt', header: 'created_at' },
  { key: 'completedAt', header: 'completed_at' },
];

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : String(value);
  // RFC 4180: wrap in quotes when the value contains comma, quote, CR or LF;
  // double any embedded quote.
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function renderCsv(items: SettlementRow[]): string {
  const header = CSV_COLUMNS.map((c) => c.header).join(',');
  const lines = items.map((r) =>
    CSV_COLUMNS.map((c) => csvEscape(r[c.key])).join(','),
  );
  return [header, ...lines].join('\r\n') + '\r\n';
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

  const session = verifySession(req.headers.authorization);
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

  const items = buildSyntheticPayouts(merchantId, limit);
  const format = (pickQuery(req.query, 'format') ?? 'json').toLowerCase();

  if (format === 'csv') {
    const today = new Date().toISOString().slice(0, 10);
    const filename = `zettapay-payouts-${merchantId}-${today}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(renderCsv(items));
    return;
  }

  if (format !== 'json') {
    fail(res, 400, 'invalid_format', 'format must be "json" or "csv"');
    return;
  }

  res.status(200).json({
    merchant: merchantId,
    network: NETWORK,
    feeBps: FEE_BPS,
    fx: {
      usdcToUsd: USDC_TO_USD,
      usdToBrl: USD_TO_BRL,
      asOf: new Date().toISOString().slice(0, 10),
    },
    pagination: { limit, total: items.length },
    summary: summarize(items),
    items,
  });
}
