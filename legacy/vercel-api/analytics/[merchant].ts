import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../_lib/base58.js';

const SERIES_DAYS = 30;
const TOP_CUSTOMERS = 5;

function normalizeMerchantRef(raw: unknown): string | null {
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
}

function deterministicPubkey(seed: string): string {
  return base58Encode(createHash('sha256').update(seed).digest());
}

// Mulberry32 — small deterministic PRNG seeded from the merchant ref so the
// preview dashboard renders stable charts across reloads.
function makeRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let t = h >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function buildSeries(rng: () => number, today: Date) {
  const series: Array<{ date: string; amount: number; count: number }> = [];
  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay();
    const weekendDip = dow === 0 || dow === 6 ? 0.55 : 1;
    const trend = 1 + (SERIES_DAYS - i) / 80;
    const noise = 0.6 + rng() * 0.9;
    const amount = Math.round(220 * weekendDip * trend * noise * 100) / 100;
    const count = Math.max(1, Math.round((amount / 18) * (0.7 + rng() * 0.6)));
    series.push({ date: d.toISOString().slice(0, 10), amount, count });
  }
  return series;
}

function sumWindow(
  series: Array<{ amount: number; count: number }>,
  days: number,
): { amount: number; count: number } {
  const slice = series.slice(-days);
  let amount = 0;
  let count = 0;
  for (const p of slice) {
    amount += p.amount;
    count += p.count;
  }
  return { amount: Math.round(amount * 100) / 100, count };
}

function buildFunnel(rng: () => number, completed: number) {
  // Realistic e-commerce drop-off: ~40-55% bounce on view→checkout,
  // ~10-20% abandon on checkout→completed. Working backwards from
  // the completed count keeps the demo internally consistent.
  const checkoutToCompleted = 0.82 + rng() * 0.12;
  const viewToCheckout = 0.45 + rng() * 0.15;
  const checkout = Math.max(
    completed,
    Math.round(completed / Math.max(0.2, checkoutToCompleted)),
  );
  const view = Math.max(checkout, Math.round(checkout / Math.max(0.2, viewToCheckout)));

  const steps = (
    [
      ["view", view],
      ["checkout", checkout],
      ["completed", completed],
    ] as const
  ).map(([name, count]) => ({
    name,
    count,
    conversionFromStart: view > 0 ? count / view : 0,
  }));

  const dropOff = [
    {
      from: "view" as const,
      to: "checkout" as const,
      dropped: Math.max(0, view - checkout),
      rate: view > 0 ? Math.max(0, view - checkout) / view : 0,
    },
    {
      from: "checkout" as const,
      to: "completed" as const,
      dropped: Math.max(0, checkout - completed),
      rate:
        checkout > 0 ? Math.max(0, checkout - completed) / checkout : 0,
    },
  ];

  return {
    windowDays: 30,
    steps,
    dropOff,
    overallRate: view > 0 ? completed / view : 0,
  };
}

function buildTopCustomers(ref: string, rng: () => number) {
  const out: Array<{
    payerWallet: string;
    totalUsdc: number;
    txCount: number;
    lastPaymentAt: string;
  }> = [];
  for (let i = 0; i < TOP_CUSTOMERS; i++) {
    const payerWallet = deterministicPubkey(`zettapay:demo:customer:${ref}:${i}`);
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
    res
      .status(405)
      .json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  const ref = normalizeMerchantRef(req.query.merchant);
  if (!ref) {
    res.status(400).json({
      error: { code: 'invalid_merchant', message: 'invalid merchant reference' },
    });
    return;
  }

  const rng = makeRng(`zettapay:analytics:${ref}`);
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
    simulated: true,
    network: 'solana-devnet',
    disclaimer:
      'Demo analytics — synthetic data deterministically derived from the merchant reference.',
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
      topCustomers: buildTopCustomers(ref, rng),
    },
  });
}
