import type { PlatformStats } from './stats.js';
import type { BotState } from './state.js';

/**
 * TPV thresholds (in USDC) that warrant a tweet. Order matters: we always
 * announce the *highest* tripped threshold and skip any lower ones we may
 * have leap-frogged (e.g. a single $1M whale push past $100k).
 */
export const TPV_THRESHOLDS_USDC: readonly number[] = [
  10_000,
  50_000,
  100_000,
  250_000,
  500_000,
  1_000_000,
  5_000_000,
  10_000_000,
  25_000_000,
  50_000_000,
  100_000_000,
];

export interface DraftedTweet {
  kind: 'tpv' | 'merchant' | 'devotion';
  text: string;
}

const HASHTAGS = '#Solana #USDC #ZettaPay';

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`;
  return `$${n.toFixed(0)}`;
}

function fmtCount(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Pick the largest threshold strictly above the last announced one and
 *  at-or-below the current TPV. Returns null when nothing is tripped. */
function tripped(currentUsdc: number, lastUsdc: number): number | null {
  let pick: number | null = null;
  for (const t of TPV_THRESHOLDS_USDC) {
    if (t > lastUsdc && t <= currentUsdc) pick = t;
  }
  return pick;
}

export function draftTpvMilestone(
  stats: PlatformStats,
  state: BotState,
): DraftedTweet | null {
  const t = tripped(stats.tpvUsdc, state.lastTpvThresholdUsdc);
  if (t === null) return null;
  const text =
    `Milestone unlocked — ZettaPay just crossed ${fmtUsd(t)} in lifetime ` +
    `payment volume settled on Solana in USDC. ` +
    `Programmable USDC, sub-cent fees, settlement in seconds. ` +
    HASHTAGS;
  return { kind: 'tpv', text };
}

export function draftNewMerchant(
  stats: PlatformStats,
  state: BotState,
): DraftedTweet | null {
  // Only shout out merchants we have not announced before. Use the explicit
  // recent-merchants list from the API rather than inferring from counts —
  // counts can move backwards (deletions) and would mis-attribute.
  const fresh = stats.recentMerchants.filter(
    (m) => !state.announcedMerchantIds.includes(m.id),
  );
  if (fresh.length === 0) return null;

  // Tweet the freshest one this tick. Remaining merchants will be picked up
  // on the next tick — keeps cadence sane and avoids X rate limits.
  const m = fresh[fresh.length - 1]!;
  const handle = m.handle ? ` (${m.handle})` : '';
  const text =
    `New merchant on ZettaPay: ${m.name}${handle} is now accepting USDC ` +
    `payments on Solana. Welcome aboard. ` +
    HASHTAGS;
  return { kind: 'merchant', text };
}

/** "Devotion" digest — recurring revenue + transaction throughput.
 *  Emits at most once per configured weekday/hour window. */
export function draftDevotionDigest(
  stats: PlatformStats,
  state: BotState,
  now: Date,
  schedule: { weekday: number; hour: number } | null,
): DraftedTweet | null {
  if (!schedule) return null;
  if (now.getUTCDay() !== schedule.weekday) return null;
  if (now.getUTCHours() !== schedule.hour) return null;

  if (state.lastWeeklyDigestAt) {
    const last = new Date(state.lastWeeklyDigestAt).getTime();
    // Only fire once per 6 days minimum — guards against hourly polls all
    // matching the same weekday/hour bucket.
    if (now.getTime() - last < 6 * 24 * 60 * 60 * 1000) return null;
  }

  if (stats.activeSubscriptions === 0 && stats.paymentsCount === 0) {
    return null;
  }

  const text =
    `Devotion check-in — this week on ZettaPay:\n` +
    `· ${fmtCount(stats.activeSubscriptions)} active subscriptions\n` +
    `· ${fmtCount(stats.paymentsCount)} lifetime payments settled\n` +
    `· ${fmtCount(stats.merchantCount)} merchants live\n` +
    HASHTAGS;
  return { kind: 'devotion', text };
}
