import type { Database as Db } from "better-sqlite3";
import {
  type Ambassador,
  type AmbassadorMetrics,
  type AmbassadorPerk,
  type AmbassadorReferral,
  type AmbassadorTier,
  getAmbassadorById,
  listRedeemedPerks,
  listReferralsForAmbassador,
  listTiers,
  metricsForAmbassador,
  updateAmbassador,
} from "../db/ambassadors.js";

/**
 * Compute the highest tier the ambassador qualifies for given current
 * metrics. A tier is unlocked when BOTH thresholds are met:
 *   - qualifiedReferrals >= tier.minQualifiedReferrals
 *   - qualifiedVolumeUsdc >= tier.minVolumeUsdc
 *
 * Tiers are evaluated in ascending position, so the last-matching tier wins.
 * Returns the tier the ambassador *should* be on; the caller decides whether
 * to persist a change.
 */
export function tierForMetrics(
  tiers: ReadonlyArray<AmbassadorTier>,
  metrics: AmbassadorMetrics,
): AmbassadorTier | null {
  if (tiers.length === 0) return null;
  const sorted = [...tiers].sort((a, b) => a.position - b.position);
  let earned: AmbassadorTier = sorted[0]!;
  for (const tier of sorted) {
    if (
      metrics.qualifiedReferrals >= tier.minQualifiedReferrals &&
      metrics.qualifiedVolumeUsdc >= tier.minVolumeUsdc
    ) {
      earned = tier;
    } else {
      break;
    }
  }
  return earned;
}

/**
 * Recompute and persist the ambassador's tier based on current referral
 * metrics. Returns the (possibly updated) ambassador along with the previous
 * and current tier slugs so callers can emit promotion events / audit rows.
 *
 * Safe to call from inside a transaction — only mutates `ambassadors` when
 * the slug actually changes.
 */
export interface TierRecomputeResult {
  ambassador: Ambassador;
  previousTierSlug: string;
  newTierSlug: string;
  promoted: boolean;
}

export function recomputeAmbassadorTier(
  db: Db,
  ambassadorId: string,
): TierRecomputeResult | null {
  const current = getAmbassadorById(db, ambassadorId);
  if (!current) return null;
  const tiers = listTiers(db);
  const metrics = metricsForAmbassador(db, ambassadorId);
  const earned = tierForMetrics(tiers, metrics);
  if (!earned) {
    return {
      ambassador: current,
      previousTierSlug: current.tierSlug,
      newTierSlug: current.tierSlug,
      promoted: false,
    };
  }
  if (earned.slug === current.tierSlug) {
    return {
      ambassador: current,
      previousTierSlug: current.tierSlug,
      newTierSlug: current.tierSlug,
      promoted: false,
    };
  }
  const updated = updateAmbassador(db, ambassadorId, { tierSlug: earned.slug });
  return {
    ambassador: updated ?? current,
    previousTierSlug: current.tierSlug,
    newTierSlug: earned.slug,
    promoted: true,
  };
}

export interface TierProgress {
  current: AmbassadorTier;
  next: AmbassadorTier | null;
  qualifiedReferralsToNext: number;
  volumeUsdcToNext: number;
}

export function tierProgress(
  tiers: ReadonlyArray<AmbassadorTier>,
  ambassador: Ambassador,
  metrics: AmbassadorMetrics,
): TierProgress | null {
  const sorted = [...tiers].sort((a, b) => a.position - b.position);
  const current =
    sorted.find((t) => t.slug === ambassador.tierSlug) ?? sorted[0];
  if (!current) return null;
  const next = sorted.find((t) => t.position > current.position) ?? null;
  return {
    current,
    next,
    qualifiedReferralsToNext: next
      ? Math.max(0, next.minQualifiedReferrals - metrics.qualifiedReferrals)
      : 0,
    volumeUsdcToNext: next
      ? Math.max(0, next.minVolumeUsdc - metrics.qualifiedVolumeUsdc)
      : 0,
  };
}

export interface AmbassadorPublicProfile {
  handle: string;
  displayName: string;
  tier: { slug: string; name: string; position: number };
  status: Ambassador["status"];
  joinedAt: string;
  referralCode: string;
  metrics: {
    qualifiedReferrals: number;
    totalVolumeUsdc: number;
    perksUnlocked: number;
  };
}

export function buildPublicProfile(
  db: Db,
  ambassador: Ambassador,
): AmbassadorPublicProfile {
  const tiers = listTiers(db);
  const metrics = metricsForAmbassador(db, ambassador.id);
  const tier =
    tiers.find((t) => t.slug === ambassador.tierSlug) ??
    tiers.find((t) => t.position === 1)!;
  const perks = listRedeemedPerks(db, ambassador.id);
  return {
    handle: ambassador.handle,
    displayName: ambassador.displayName,
    tier: { slug: tier.slug, name: tier.name, position: tier.position },
    status: ambassador.status,
    joinedAt: ambassador.joinedAt,
    referralCode: ambassador.referralCode,
    metrics: {
      qualifiedReferrals: metrics.qualifiedReferrals,
      totalVolumeUsdc: metrics.totalVolumeUsdc,
      perksUnlocked: perks.length,
    },
  };
}

export interface AmbassadorDashboard {
  ambassador: Ambassador;
  metrics: AmbassadorMetrics;
  tierProgress: TierProgress;
  perksAvailable: string[];
  perksRedeemed: AmbassadorPerk[];
  recentReferrals: AmbassadorReferral[];
  shareLink: string;
}

export interface BuildDashboardOptions {
  /** Public site origin used to render the shareable referral URL. */
  siteUrl?: string;
}

export function buildDashboard(
  db: Db,
  ambassador: Ambassador,
  options: BuildDashboardOptions = {},
): AmbassadorDashboard {
  const tiers = listTiers(db);
  const metrics = metricsForAmbassador(db, ambassador.id);
  const progress = tierProgress(tiers, ambassador, metrics);
  if (!progress) {
    throw new Error("ambassador_tiers table is empty — schema not seeded");
  }
  const siteUrl = (options.siteUrl ?? "https://zettapay.io").replace(
    /\/+$/,
    "",
  );
  return {
    ambassador,
    metrics,
    tierProgress: progress,
    perksAvailable: progress.current.perks,
    perksRedeemed: listRedeemedPerks(db, ambassador.id),
    recentReferrals: listReferralsForAmbassador(db, ambassador.id, { limit: 25 }),
    shareLink: `${siteUrl}/r/${ambassador.referralCode}`,
  };
}
