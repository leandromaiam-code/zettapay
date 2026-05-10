import { logger } from './logger.js';

/**
 * Aggregate, public-safe metrics returned by the ZettaPay platform.
 * The shape is intentionally narrow — no payer wallets, no per-merchant
 * revenue, no PII. The bot must NEVER tweet anything not present here.
 */
export interface PlatformStats {
  /** Lifetime total payment volume in USDC. */
  tpvUsdc: number;
  /** Total registered merchants (lifetime). */
  merchantCount: number;
  /** Active subscriptions (recurring "devotion" signal). */
  activeSubscriptions: number;
  /** Lifetime completed payments count. */
  paymentsCount: number;
  /** Newly registered merchants since the last poll, oldest first.
   *  Each has a stable id and a public-safe display name. */
  recentMerchants: Array<{
    id: string;
    name: string;
    /** Optional public handle (@) the merchant chose to share. */
    handle?: string;
    createdAt: string;
  }>;
}

export class StatsFetchError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'StatsFetchError';
  }
}

export async function fetchStats(apiBase: string): Promise<PlatformStats> {
  const url = `${apiBase.replace(/\/+$/, '')}/v1/public/stats`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        'user-agent': 'zettapay-twitter-bot/0.1',
      },
    });
  } catch (err) {
    throw new StatsFetchError(
      `network error fetching ${url}: ${(err as Error).message}`,
    );
  }

  if (!res.ok) {
    throw new StatsFetchError(
      `stats endpoint ${url} returned ${res.status}`,
      res.status,
    );
  }

  const body = (await res.json()) as Partial<PlatformStats> & {
    recentMerchants?: unknown;
  };

  const recent = Array.isArray(body.recentMerchants)
    ? (body.recentMerchants as Array<Record<string, unknown>>)
        .map((m) => ({
          id: String(m.id ?? ''),
          name: String(m.name ?? ''),
          handle:
            typeof m.handle === 'string' && m.handle.length > 0
              ? m.handle
              : undefined,
          createdAt: String(m.createdAt ?? new Date().toISOString()),
        }))
        .filter((m) => m.id.length > 0 && m.name.length > 0)
    : [];

  const stats: PlatformStats = {
    tpvUsdc: Number(body.tpvUsdc ?? 0),
    merchantCount: Number(body.merchantCount ?? 0),
    activeSubscriptions: Number(body.activeSubscriptions ?? 0),
    paymentsCount: Number(body.paymentsCount ?? 0),
    recentMerchants: recent,
  };

  logger.debug({ stats }, 'fetched platform stats');
  return stats;
}
