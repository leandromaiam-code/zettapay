// @ts-nocheck — Node 18+ has global fetch, TS 4.9 cannot type it (matches PR #100)
import type { VercelRequest } from '@vercel/node';

/**
 * Shape returned by the Express /status endpoint and re-served by the
 * Vercel serverless functions. Kept inline (not imported from the API
 * package) so the function bundle stays self-contained.
 */
export type ComponentStatus =
  | 'operational'
  | 'degraded_performance'
  | 'partial_outage'
  | 'major_outage';

export type IncidentLifecycle =
  | 'investigating'
  | 'identified'
  | 'monitoring'
  | 'resolved';

export type IncidentImpact = 'none' | 'minor' | 'major' | 'critical';

export type OverallStatus =
  | 'all_systems_operational'
  | 'minor_outage'
  | 'partial_outage'
  | 'major_outage'
  | 'no_components_configured';

export interface StatusComponent {
  id: string;
  name: string;
  description: string | null;
  position: number;
  status: ComponentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface StatusIncidentUpdate {
  id: string;
  incidentId: string;
  status: IncidentLifecycle;
  body: string;
  createdAt: string;
}

export interface IncidentWithDetails {
  id: string;
  title: string;
  status: IncidentLifecycle;
  impact: IncidentImpact;
  startedAt: string;
  resolvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  componentIds: string[];
  updates: StatusIncidentUpdate[];
}

export interface StatusSummary {
  overall: OverallStatus;
  generatedAt: string;
  components: StatusComponent[];
  activeIncidents: IncidentWithDetails[];
  recentlyResolved: IncidentWithDetails[];
}

/**
 * Default component roster the public page falls back to when no upstream
 * Express service is configured. Mirrors the Z18.4 monitored systems so the
 * page renders something meaningful from day one.
 */
const DEFAULT_COMPONENTS: ReadonlyArray<StatusComponent> = [
  {
    id: 'cmp_api',
    name: 'Payments API',
    description: 'POST /pay, /payments — core payment processing.',
    position: 0,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cmp_solana_rpc',
    name: 'Solana RPC',
    description: 'Upstream Solana mainnet RPC used to settle USDC transfers.',
    position: 1,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cmp_indexer',
    name: 'On-chain indexer',
    description: 'Helius/Geyser webhook + backfill mirroring on-chain receipts.',
    position: 2,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cmp_webhooks',
    name: 'Outbound webhooks',
    description: 'Merchant webhook delivery + retry queue.',
    position: 3,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cmp_onramp',
    name: 'Onramp (MoonPay)',
    description: 'Fiat onramp + MoonPay webhook delivery.',
    position: 4,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
  {
    id: 'cmp_dashboard',
    name: 'Merchant dashboard',
    description: 'Merchant onboarding, payouts, analytics UI.',
    position: 5,
    status: 'operational',
    createdAt: '2026-05-10T00:00:00.000Z',
    updatedAt: '2026-05-10T00:00:00.000Z',
  },
];

const DEFAULT_SUMMARY: StatusSummary = {
  overall: 'all_systems_operational',
  generatedAt: new Date(0).toISOString(),
  components: [...DEFAULT_COMPONENTS],
  activeIncidents: [],
  recentlyResolved: [],
};

const FETCH_TIMEOUT_MS = 2_500;

/**
 * Fetch the live status snapshot from the Express service when configured
 * via STATUS_API_URL. Falls back to a baseline operational snapshot so the
 * public page never 5xx — uptime of the status page itself is the whole
 * point of Z18.4.
 */
export async function fetchStatusSummary(_req: VercelRequest): Promise<StatusSummary> {
  const upstream = (process.env.STATUS_API_URL ?? '').trim();
  if (!upstream) return freshDefault();

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const url = `${upstream.replace(/\/+$/, '')}/status`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    clearTimeout(timer);
    if (!resp.ok) return freshDefault();
    const body = (await resp.json()) as StatusSummary;
    if (!body || typeof body !== 'object' || !Array.isArray(body.components)) {
      return freshDefault();
    }
    return body;
  } catch {
    return freshDefault();
  }
}

export async function fetchStatusFeedXml(): Promise<string | null> {
  const upstream = (process.env.STATUS_API_URL ?? '').trim();
  if (!upstream) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const url = `${upstream.replace(/\/+$/, '')}/status/feed.rss`;
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/rss+xml' },
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function freshDefault(): StatusSummary {
  return {
    ...DEFAULT_SUMMARY,
    generatedAt: new Date().toISOString(),
    components: [...DEFAULT_COMPONENTS],
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildFallbackRss(summary: StatusSummary, siteUrl: string): string {
  const site = siteUrl.replace(/\/+$/, '');
  const items = summary.activeIncidents
    .concat(summary.recentlyResolved)
    .flatMap((inc) =>
      inc.updates.map((u) => ({
        title: `[${u.status}] ${inc.title}`,
        link: `${site}/status/incidents/${inc.id}`,
        guid: `${inc.id}:${u.id}`,
        pubDate: new Date(u.createdAt).toUTCString(),
        category: inc.impact,
        description: u.body,
      })),
    )
    .slice(0, 50);

  const itemsXml = items
    .map(
      (it) => `    <item>
      <title>${escapeXml(it.title)}</title>
      <link>${escapeXml(it.link)}</link>
      <guid isPermaLink="false">${escapeXml(it.guid)}</guid>
      <pubDate>${it.pubDate}</pubDate>
      <category>${escapeXml(it.category)}</category>
      <description>${escapeXml(it.description)}</description>
    </item>`,
    )
    .join('\n');

  const lastBuild = items[0]?.pubDate ?? new Date().toUTCString();
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>ZettaPay status</title>
    <link>${escapeXml(`${site}/status`)}</link>
    <description>Live incident updates and historical reliability for the ZettaPay platform.</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${escapeXml(`${site}/status/feed.rss`)}" rel="self" type="application/rss+xml" />
${itemsXml}
  </channel>
</rss>
`;
}

export function siteUrlFromRequest(req: VercelRequest): string {
  const env = (process.env.STATUS_PAGE_SITE_URL ?? '').trim();
  if (env) return env.replace(/\/+$/, '');
  const host = (req.headers['x-forwarded-host'] ?? req.headers.host ?? 'status.zettapay.io') as string;
  const protoHeader = req.headers['x-forwarded-proto'] as string | undefined;
  const proto = (protoHeader ?? 'https').split(',')[0]?.trim() ?? 'https';
  return `${proto}://${host}`;
}
