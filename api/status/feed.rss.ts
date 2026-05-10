import type { VercelRequest, VercelResponse } from '@vercel/node';
import { withSentry } from '../_lib/sentry.js';
import {
  buildFallbackRss,
  fetchStatusFeedXml,
  fetchStatusSummary,
  siteUrlFromRequest,
} from '../_lib/status-source.js';

async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    res.status(405).json({ error: { code: 'method_not_allowed', message: 'GET only' } });
    return;
  }

  // Prefer the upstream RSS rendering (includes full incident history) when
  // the Express service is reachable. Fall back to a synthesized feed built
  // from the snapshot so feed readers always see well-formed XML.
  const upstreamXml = await fetchStatusFeedXml();
  const xml = upstreamXml ?? buildFallbackRss(await fetchStatusSummary(req), siteUrlFromRequest(req));

  res.setHeader('Content-Type', 'application/rss+xml; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
  res.status(200).send(xml);
}

export default withSentry(handler);
