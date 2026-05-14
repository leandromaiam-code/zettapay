import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../../_lib/base58.js';
import { normalizeMerchantId } from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

const NETWORK = 'solana-devnet';
const SERIES_DAYS = 30;
const TOP_CUSTOMERS = 5;

type ErrorBody = { error: { code: string; message: string } };

function fail(res: VercelResponse, status: number, code: string, message: string): void {
  const body: ErrorBody = { error: { code, message } };
  res.status(status).json(body);
}

function deterministicPubkey(seed: string): string {
  return base58Encode(createHash('sha256').update(seed).digest());
}

// Mulberry32-derived deterministic PRNG seeded from the merchant id so charts
// stay stable across reloads until live indexer data lands.
function makeRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let t = h >>> 0;
  return (): number => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

interface SeriesPoint {
  date: string;
  amount: number;
  count: number;
}

function buildSeries(rng: () => number, today: Date): SeriesPoint[] {
  const series: SeriesPoint[] = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay();
    const weekendDip = dow === 0 || dow === 6 ? 0.55 : 1;
    const trend = 1 + (SERIES_DAYS - i) / 80;
    const noise = 0.6 + rng() * 0.9;
    const amount = Math.round(220 * weekendDip * trend * noise * 100) / 100;
    const count = Math.max(1, Math.round((amount / 18) * (0.7 + rng() * 0.6)));
    const dateStr = d.toISOString().slice(0, 10);
    series.push({ date: dateStr, amount, count });
  }
  return series;
}

function sumWindow(series: SeriesPoint[], days: number): { amount: number; count: number } {
  const slice = series.slice(-days);
  let amount = 0;
  let count = 0;
  for (const p of slice) {
    amount += p.amount;
    count += p.count;
  }
  return { amount: Math.round(amount * 100) / 100, count };
}

interface FunnelStep {
  name: 'view' | 'checkout' | 'completed';
  count: number;
  conversionFromStart: number;
}

interface FunnelDropOff {
  from: 'view' | 'checkout';
  to: 'checkout' | 'completed';
  dropped: number;
  rate: number;
}

interface Funnel {
  windowDays: number;
  steps: FunnelStep[];
  dropOff: FunnelDropOff[];
  overallRate: number;
}

function buildFunnel(rng: () => number, completed: number): Funnel {
  const checkoutToCompleted = 0.82 + rng() * 0.12;
  const viewToCheckout = 0.45 + rng() * 0.15;
  const checkout = Math.max(
    completed,
    Math.round(completed / Math.max(0.2, checkoutToCompleted)),
  );
  const view = Math.max(checkout, Math.round(checkout / Math.max(0.2, viewToCheckout)));

  const steps: FunnelStep[] = (
    [
      ['view', view],
      ['checkout', checkout],
      ['completed', completed],
    ] as const
  ).map(([name, count]) => ({
    name,
    count,
    conversionFromStart: view > 0 ? count / view : 0,
  }));

  const dropOff: FunnelDropOff[] = [
    {
      from: 'view',
      to: 'checkout',
      dropped: Math.max(0, view - checkout),
      rate: view > 0 ? Math.max(0, view - checkout) / view : 0,
    },
    {
      from: 'checkout',
      to: 'completed',
      dropped: Math.max(0, checkout - completed),
      rate: checkout > 0 ? Math.max(0, checkout - completed) / checkout : 0,
    },
  ];

  return {
    windowDays: 30,
    steps,
    dropOff,
    overallRate: view > 0 ? completed / view : 0,
  };
}

interface TopCustomer {
  payerWallet: string;
  totalUsdc: number;
  txCount: number;
  lastPaymentAt: string;
}

function buildTopCustomers(merchantId: string, rng: () => number): TopCustomer[] {
  const out: TopCustomer[] = [];
  for (let i = 0; i < TOP_CUSTOMERS; i++) {
    const payerWallet = deterministicPubkey(`zettapay:dash:customer:${merchantId}:${i}`);
    const totalUsdc = Math.round((400 - i * 60 + rng() * 80) * 100) / 100;
    const txCount = Math.max(1, Math.round((TOP_CUSTOMERS - i) * 3 + rng() * 4));
    const hoursAgo = Math.round(rng() * 72) + i * 6;
    const lastPaymentAt = new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
    out.push({ payerWallet, totalUsdc, txCount, lastPaymentAt });
  }
  return out;
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

  const rng = makeRng(`zettapay:dash:analytics:${merchantId}`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const tpvSeries = buildSeries(rng, today);
  const todayWindow = sumWindow(tpvSeries, 1);
  const weekWindow = sumWindow(tpvSeries, 7);
  const monthWindow = sumWindow(tpvSeries, 30);

  const totalCount = monthWindow.count;
  const failed = Math.max(1, Math.round(totalCount * 0.06));
  const pending = Math.max(0, Math.round(totalCount * 0.02));
  const completed = Math.max(0, totalCount - failed - pending);
  const denom = completed + failed;
  const rate = denom > 0 ? completed / denom : 0;

  const mrr = Math.round((monthWindow.amount * 0.12 + 600) * 100) / 100;

  res.status(200).json({
    merchant: merchantId,
    simulated: true,
    network: NETWORK,
    disclaimer:
      'Demo analytics — synthetic data deterministically derived from the merchant id; wires to live indexer at mainnet.',
    analytics: {
      generatedAt: new Date().toISOString(),
      tpv: {
        today: todayWindow,
        week: weekWindow,
        month: monthWindow,
      },
      tpvSeries,
      mrr,
      conversion: {
        total: totalCount,
        completed,
        failed,
        pending,
        rate: Math.round(rate * 10000) / 10000,
      },
      funnel: buildFunnel(rng, completed),
      topCustomers: buildTopCustomers(merchantId, rng),
    },
  });
}
