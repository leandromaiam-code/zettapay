import type { Database as Db } from "better-sqlite3";
import {
  type ComponentStatus,
  type IncidentImpact,
  type IncidentLifecycle,
  type RecentUpdateForFeed,
  type StatusComponent,
  type StatusIncident,
  type StatusIncidentUpdate,
  listIncidentComponentIds,
  listIncidentUpdates,
  listRecentUpdatesForFeed,
  listStatusComponents,
  listStatusIncidents,
} from "../db/status_page.js";

export type OverallStatus =
  | "all_systems_operational"
  | "minor_outage"
  | "partial_outage"
  | "major_outage"
  | "no_components_configured";

const COMPONENT_SEVERITY: Record<ComponentStatus, number> = {
  operational: 0,
  degraded_performance: 1,
  partial_outage: 2,
  major_outage: 3,
};

const SEVERITY_TO_OVERALL: Record<number, OverallStatus> = {
  0: "all_systems_operational",
  1: "minor_outage",
  2: "partial_outage",
  3: "major_outage",
};

export function computeOverallStatus(
  components: ReadonlyArray<StatusComponent>,
): OverallStatus {
  if (components.length === 0) return "no_components_configured";
  let worst = 0;
  for (const c of components) {
    const s = COMPONENT_SEVERITY[c.status] ?? 0;
    if (s > worst) worst = s;
  }
  return SEVERITY_TO_OVERALL[worst] ?? "all_systems_operational";
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

export function hydrateIncident(
  db: Db,
  incident: StatusIncident,
): IncidentWithDetails {
  return {
    id: incident.id,
    title: incident.title,
    status: incident.status,
    impact: incident.impact,
    startedAt: incident.startedAt,
    resolvedAt: incident.resolvedAt,
    createdAt: incident.createdAt,
    updatedAt: incident.updatedAt,
    componentIds: listIncidentComponentIds(db, incident.id),
    updates: listIncidentUpdates(db, incident.id),
  };
}

export interface StatusSummary {
  overall: OverallStatus;
  generatedAt: string;
  components: StatusComponent[];
  activeIncidents: IncidentWithDetails[];
  recentlyResolved: IncidentWithDetails[];
}

export function buildStatusSummary(db: Db): StatusSummary {
  const components = listStatusComponents(db);
  const active = listStatusIncidents(db, { activeOnly: true, limit: 25 });
  const all = listStatusIncidents(db, { limit: 25 });
  const recentlyResolved = all.filter((i) => i.status === "resolved").slice(0, 5);
  return {
    overall: computeOverallStatus(components),
    generatedAt: new Date().toISOString(),
    components,
    activeIncidents: active.map((i) => hydrateIncident(db, i)),
    recentlyResolved: recentlyResolved.map((i) => hydrateIncident(db, i)),
  };
}

export interface RssFeedOptions {
  /** Public site origin used for incident links and channel link. */
  siteUrl: string;
  /** Channel title shown by feed readers. */
  title: string;
  /** Channel description shown by feed readers. */
  description: string;
  /** Hard cap on items in the feed. Defaults to 50. */
  limit?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function toRfc822(iso: string): string {
  // RSS 2.0 requires RFC 822 dates (e.g. "Tue, 12 May 2026 09:30:00 GMT").
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return new Date().toUTCString();
  return d.toUTCString();
}

function trimTrailingSlash(input: string): string {
  return input.replace(/\/+$/, "");
}

export function buildRssFeed(
  db: Db,
  options: RssFeedOptions,
): string {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 200));
  const items = listRecentUpdatesForFeed(db, limit);
  const site = trimTrailingSlash(options.siteUrl);
  const feedSelf = `${site}/status/feed.rss`;
  const lastBuild =
    items.length > 0 ? toRfc822(items[0]!.update.createdAt) : new Date().toUTCString();

  const itemBlocks = items
    .map((entry) => renderRssItem(entry, site))
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(options.title)}</title>
    <link>${escapeXml(`${site}/status`)}</link>
    <description>${escapeXml(options.description)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <atom:link href="${escapeXml(feedSelf)}" rel="self" type="application/rss+xml" />
${itemBlocks}
  </channel>
</rss>
`;
}

function renderRssItem(entry: RecentUpdateForFeed, site: string): string {
  const { update, incident } = entry;
  const link = `${site}/status/incidents/${incident.id}`;
  const guid = `${incident.id}:${update.id}`;
  const title = `[${update.status}] ${incident.title}`;
  return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${toRfc822(update.createdAt)}</pubDate>
      <category>${escapeXml(incident.impact)}</category>
      <description>${escapeXml(update.body)}</description>
    </item>`;
}
