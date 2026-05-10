import { createHash } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { base58Encode } from '../../_lib/base58.js';
import { normalizeMerchantId } from '../../_lib/merchant.js';
import { verifySession } from '../../_lib/session.js';

const NETWORK = 'solana-devnet';
const SERIES_DAYS = 30;
const DEFAULT_AGENT_COUNT = 18;
const TOP_LIMIT = 5;
const RECENT_LIMIT = 10;

interface ProviderCatalogEntry {
  id: string;
  label: string;
  weight: number;
}

const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  { id: 'anthropic', label: 'Anthropic Claude', weight: 1.7 },
  { id: 'openai', label: 'OpenAI GPT', weight: 1.5 },
  { id: 'google', label: 'Google Gemini', weight: 1.0 },
  { id: 'perplexity', label: 'Perplexity', weight: 0.7 },
  { id: 'mistral', label: 'Mistral', weight: 0.5 },
  { id: 'xai', label: 'xAI Grok', weight: 0.4 },
];

const AGENT_NAMES = [
  'shopper-bot', 'data-fetch', 'mcp-broker', 'code-reviewer',
  'travel-planner', 'invoice-runner', 'lead-scout', 'support-triage',
  'content-pipeline', 'chart-builder', 'market-watcher', 'inbox-zero',
  'doc-rag', 'pricing-agent', 'spec-writer', 'crawler-prime',
  'release-bot', 'forecast-runner',
];

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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

interface SyntheticAgent {
  id: string;
  provider: string;
  providerLabel: string;
  agentId: string;
  displayName: string;
  publicKey: string;
  totalUsdc: number;
  txCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

function buildAgents(merchantId: string, count: number): SyntheticAgent[] {
  const rng = makeRng(`zettapay:agents:${merchantId}`);
  const now = Date.now();
  const out: SyntheticAgent[] = [];

  let providerWeightSum = 0;
  for (const p of PROVIDER_CATALOG) providerWeightSum += p.weight;

  for (let i = 0; i < count; i++) {
    let pick = rng() * providerWeightSum;
    let provider = PROVIDER_CATALOG[0]!;
    for (const p of PROVIDER_CATALOG) {
      pick -= p.weight;
      if (pick <= 0) { provider = p; break; }
    }

    const namePart = AGENT_NAMES[i % AGENT_NAMES.length] ?? 'agent';
    const suffix = base58Encode(
      createHash('sha256').update(`zettapay:agents:${merchantId}:${i}`).digest(),
    ).slice(0, 4).toLowerCase();
    const agentId = `${namePart}-${suffix}`;
    const displayName = namePart
      .split('-')
      .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
      .join(' ');

    const publicKey = deterministicPubkey(`agent:${merchantId}:${agentId}`);

    const ranking = 1 / (i + 1);
    const txCount = Math.max(1, Math.round((6 + rng() * 22) * (0.4 + ranking * 1.6)));
    const avgTicket = round2(0.05 + rng() * 4.5);
    const totalUsdc = round2(txCount * avgTicket * (0.7 + rng() * 0.6));

    const lastSeenHoursAgo = Math.round(rng() * 96) + i;
    const lastSeenAt = new Date(now - lastSeenHoursAgo * 3_600_000).toISOString();
    const firstSeenDaysAgo = Math.max(1, Math.round(rng() * 180) + i * 2);
    const firstSeenAt = new Date(now - firstSeenDaysAgo * 86_400_000).toISOString();

    out.push({
      id: 'ai_' + base58Encode(
        createHash('sha256').update(`zettapay:agents:id:${merchantId}:${i}`).digest(),
      ).slice(0, 18),
      provider: provider.id,
      providerLabel: provider.label,
      agentId,
      displayName,
      publicKey,
      totalUsdc,
      txCount,
      firstSeenAt,
      lastSeenAt,
    });
  }

  out.sort((a, b) => b.totalUsdc - a.totalUsdc);
  return out;
}

interface DailyPoint {
  date: string;
  totalUsdc: number;
  txCount: number;
  agentCount: number;
}

function buildDailySeries(merchantId: string, agents: SyntheticAgent[]): DailyPoint[] {
  const rng = makeRng(`zettapay:agents:series:${merchantId}`);
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const series: DailyPoint[] = [];

  for (let i = SERIES_DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime());
    d.setUTCDate(d.getUTCDate() - i);
    const dow = d.getUTCDay();
    const weekendDip = dow === 0 || dow === 6 ? 0.62 : 1;
    const trend = 1 + (SERIES_DAYS - i) / 70;
    const noise = 0.65 + rng() * 0.85;

    const baseTx = Math.max(1, Math.round((agents.length * 1.4) * weekendDip * noise));
    const txCount = Math.round(baseTx * trend);
    const avgTicket = 0.7 + rng() * 2.3;
    const totalUsdc = round2(txCount * avgTicket * weekendDip);
    const agentCount = Math.max(
      1,
      Math.min(agents.length, Math.round(agents.length * (0.35 + rng() * 0.5))),
    );

    series.push({
      date: d.toISOString().slice(0, 10),
      totalUsdc,
      txCount,
      agentCount,
    });
  }
  return series;
}

interface ProviderRollup {
  provider: string;
  providerLabel: string;
  agentCount: number;
  txCount: number;
  totalUsdc: number;
  share: number;
}

function buildProviderBreakdown(agents: SyntheticAgent[]): ProviderRollup[] {
  const map = new Map<string, ProviderRollup>();
  for (const cat of PROVIDER_CATALOG) {
    map.set(cat.id, {
      provider: cat.id,
      providerLabel: cat.label,
      agentCount: 0,
      txCount: 0,
      totalUsdc: 0,
      share: 0,
    });
  }
  let grandTotal = 0;
  for (const a of agents) {
    const row = map.get(a.provider);
    if (!row) continue;
    row.agentCount += 1;
    row.txCount += a.txCount;
    row.totalUsdc = round2(row.totalUsdc + a.totalUsdc);
    grandTotal += a.totalUsdc;
  }
  const out: ProviderRollup[] = [];
  for (const row of map.values()) {
    if (row.agentCount === 0) continue;
    row.share = grandTotal > 0 ? Math.round((row.totalUsdc / grandTotal) * 10000) / 10000 : 0;
    out.push(row);
  }
  out.sort((a, b) => b.totalUsdc - a.totalUsdc);
  return out;
}

interface RecentActivity {
  id: string;
  amountUsdc: number;
  status: 'completed' | 'pending';
  agent: { agentId: string; displayName: string; provider: string; providerLabel: string };
  acceptedAt: string;
}

function buildRecentActivity(merchantId: string, agents: SyntheticAgent[]): RecentActivity[] {
  const rng = makeRng(`zettapay:agents:recent:${merchantId}`);
  const out: RecentActivity[] = [];
  const top = agents.slice(0, Math.min(agents.length, 12));
  for (let i = 0; i < RECENT_LIMIT && top.length > 0; i++) {
    const idx = Math.floor(rng() * top.length);
    const a = top[idx]!;
    const minutesAgo = i * 11 + Math.round(rng() * 90);
    const acceptedAt = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    const cents = Math.max(5, Math.round(rng() * 950));
    const status: RecentActivity['status'] = rng() > 0.92 ? 'pending' : 'completed';
    out.push({
      id: 'pay_' + base58Encode(
        createHash('sha256').update(`zettapay:agents:recent:${merchantId}:${i}`).digest(),
      ).slice(0, 14),
      amountUsdc: round2(cents / 100),
      status,
      agent: {
        agentId: a.agentId,
        displayName: a.displayName,
        provider: a.provider,
        providerLabel: a.providerLabel,
      },
      acceptedAt,
    });
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

  const limitRaw = pickQuery(req.query, 'agents');
  let agentCount = DEFAULT_AGENT_COUNT;
  if (limitRaw !== undefined) {
    const parsed = Number.parseInt(limitRaw, 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 64) {
      fail(res, 400, 'invalid_agents', 'agents must be 1..64');
      return;
    }
    agentCount = parsed;
  }

  const agents = buildAgents(merchantId, agentCount);
  const dailySeries = buildDailySeries(merchantId, agents);
  const providerBreakdown = buildProviderBreakdown(agents);
  const recent = buildRecentActivity(merchantId, agents);

  const totalUsdc = round2(agents.reduce((s, a) => s + a.totalUsdc, 0));
  const txCount30d = dailySeries.reduce((s, p) => s + p.txCount, 0);
  const avgTicketUsdc = txCount30d > 0 ? round2(totalUsdc / txCount30d) : 0;
  const dayMs = 86_400_000;
  const cutoff24h = Date.now() - dayMs;
  const activeLast24h = agents.filter(
    (a) => new Date(a.lastSeenAt).getTime() >= cutoff24h,
  ).length;
  const cutoff7d = Date.now() - 7 * dayMs;
  const newAgents7d = agents.filter(
    (a) => new Date(a.firstSeenAt).getTime() >= cutoff7d,
  ).length;

  const topSpenders = agents.slice(0, TOP_LIMIT).map((a) => ({
    id: a.id,
    provider: a.provider,
    providerLabel: a.providerLabel,
    agentId: a.agentId,
    displayName: a.displayName,
    publicKey: a.publicKey,
    totalUsdc: a.totalUsdc,
    txCount: a.txCount,
    avgTicketUsdc: a.txCount > 0 ? round2(a.totalUsdc / a.txCount) : 0,
    lastSeenAt: a.lastSeenAt,
  }));

  const topByTxCount = [...agents]
    .sort((a, b) => b.txCount - a.txCount)
    .slice(0, TOP_LIMIT)
    .map((a) => ({
      id: a.id,
      provider: a.provider,
      providerLabel: a.providerLabel,
      agentId: a.agentId,
      displayName: a.displayName,
      txCount: a.txCount,
      totalUsdc: a.totalUsdc,
      lastSeenAt: a.lastSeenAt,
    }));

  res.status(200).json({
    simulated: true,
    merchant: merchantId,
    network: NETWORK,
    currency: 'USDC',
    disclaimer:
      'Demo agent analytics — synthetic data deterministically derived from the merchant id.',
    summary: {
      distinctAgentCount: agents.length,
      activeLast24h,
      newAgentsLast7d: newAgents7d,
      txCount30d,
      totalSpentUsdc: totalUsdc,
      avgTicketUsdc,
    },
    topSpenders,
    topByTxCount,
    providerBreakdown,
    dailySeries,
    recentActivity: recent,
  });
}
