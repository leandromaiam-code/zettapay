import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { z } from "zod";
import { appendAudit } from "../db/audit_journal.js";
import {
  type Ambassador,
  type AmbassadorStatus,
  createAmbassador,
  createReferral,
  ensureAmbassadorsSchema,
  getAmbassadorByHandle,
  getAmbassadorById,
  getAmbassadorByReferralCode,
  getReferralById,
  getTierBySlug,
  listAmbassadors,
  listTiers,
  patchTier,
  recordReferralClick,
  redeemPerk,
  updateAmbassador,
  updateReferral,
} from "../db/ambassadors.js";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { adminAuth } from "../middleware/admin-auth.js";
import {
  buildDashboard,
  buildPublicProfile,
  recomputeAmbassadorTier,
} from "../services/ambassadors.js";

export interface AmbassadorsRouterOptions {
  /** Shared admin key (>=24 chars). Without it, admin write endpoints
   *  hard-fail with config_error — public read endpoints stay live. */
  adminKey: string | null | undefined;
  /** Public site origin used when rendering shareable referral URLs. */
  siteUrl?: string;
}

const HANDLE_REGEX = /^[a-z0-9][a-z0-9._-]{1,38}$/;
const REFERRAL_CODE_REGEX = /^[a-z0-9][a-z0-9._-]{2,38}$/i;
const PERK_KEY_REGEX = /^[a-z0-9][a-z0-9_]{1,48}$/;

const ambassadorStatusSchema: z.ZodType<AmbassadorStatus> = z.enum([
  "active",
  "inactive",
  "suspended",
]);

const createAmbassadorSchema = z.object({
  handle: z.string().regex(HANDLE_REGEX, "handle must match [a-z0-9._-]"),
  displayName: z.string().min(1).max(120),
  email: z.string().email().max(254),
  walletAddress: z.string().min(32).max(64).nullable().optional(),
  referralCode: z
    .string()
    .regex(REFERRAL_CODE_REGEX, "invalid referral code")
    .optional(),
  tierSlug: z.string().min(1).max(64).optional(),
  status: ambassadorStatusSchema.optional(),
});

const updateAmbassadorSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  walletAddress: z.string().min(32).max(64).nullable().optional(),
  status: ambassadorStatusSchema.optional(),
  tierSlug: z.string().min(1).max(64).optional(),
});

const createReferralSchema = z.object({
  referredMerchantId: z.string().min(1).max(64).nullable().optional(),
  referredLabel: z.string().max(160).nullable().optional(),
  source: z.enum(["signup", "manual", "payment"]).optional(),
  status: z.enum(["pending", "qualified"]).optional(),
  volumeUsdc: z.number().min(0).max(1_000_000_000).optional(),
});

const updateReferralSchema = z.object({
  status: z.enum(["pending", "qualified"]).optional(),
  volumeUsdc: z.number().min(0).max(1_000_000_000).optional(),
  referredMerchantId: z.string().min(1).max(64).nullable().optional(),
  referredLabel: z.string().max(160).nullable().optional(),
});

const redeemPerkSchema = z.object({
  metadata: z.record(z.unknown()).optional(),
});

const patchTierSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  position: z.number().int().min(1).max(100).optional(),
  minQualifiedReferrals: z.number().int().min(0).max(1_000_000).optional(),
  minVolumeUsdc: z.number().min(0).max(1_000_000_000).optional(),
  description: z.string().max(2_000).nullable().optional(),
  perks: z.array(z.string().regex(PERK_KEY_REGEX)).max(64).optional(),
});

const trackClickSchema = z.object({
  source: z.string().max(120).nullable().optional(),
});

function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function badRequestFromZod(err: z.ZodError): HttpError {
  return HttpError.badRequest("invalid request body", err.flatten());
}

function generateReferralCode(handle: string): string {
  const sanitized = handle.toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${sanitized.slice(0, 24)}-${suffix}`;
}

function publicAmbassadorView(ambassador: Ambassador) {
  return {
    handle: ambassador.handle,
    displayName: ambassador.displayName,
    tierSlug: ambassador.tierSlug,
    status: ambassador.status,
    joinedAt: ambassador.joinedAt,
    referralCode: ambassador.referralCode,
  };
}

/**
 * Z19.4 ambassadors program — tier system + referral attribution + perks.
 *
 *  PUBLIC
 *   - GET  /ambassadors                     — list active ambassadors
 *   - GET  /ambassadors/tiers               — tier catalog with perk lists
 *   - GET  /ambassadors/leaderboard         — sorted by qualified volume
 *   - GET  /ambassadors/r/:code             — resolve referral code → metadata
 *   - POST /ambassadors/r/:code/click       — record a click for attribution
 *   - GET  /ambassadors/:handle             — public profile (tier, totals)
 *
 *  ADMIN  (gated by ZETTAPAY_ADMIN_KEY — same key/middleware as Z10.5/Z18.4)
 *   - POST  /admin/ambassadors                              create
 *   - PATCH /admin/ambassadors/:handle                      update profile/tier
 *   - GET   /admin/ambassadors/:handle/dashboard            full metrics dashboard
 *   - POST  /admin/ambassadors/:handle/referrals            attribute a referral
 *   - PATCH /admin/ambassadors/:handle/referrals/:id        qualify / set volume
 *   - POST  /admin/ambassadors/:handle/perks/:perkKey/redeem
 *   - PATCH /admin/ambassador-tiers/:slug                   tune thresholds/perks
 *
 * Tier promotion runs automatically after every referral mutation. The audit
 * journal captures the actor, before/after tier slugs, and the metrics
 * snapshot that triggered the promotion — Premissa #24 (audit-ready).
 */
export function ambassadorsRouter(
  db: Db,
  options: AmbassadorsRouterOptions,
): Router {
  ensureAmbassadorsSchema(db);
  const router = Router();
  const auth = adminAuth({ adminKey: options.adminKey });
  const siteUrl =
    options.siteUrl ??
    process.env.AMBASSADORS_SITE_URL ??
    "https://zettapay.io";

  router.get(
    "/ambassadors",
    asyncHandler((req, res) => {
      const limit = parseIntInRange(req.query.limit, 1, 200, 50);
      const offset = parseIntInRange(req.query.offset, 0, 10_000, 0);
      const status =
        typeof req.query.status === "string" &&
        ["active", "inactive", "suspended"].includes(req.query.status)
          ? (req.query.status as AmbassadorStatus)
          : "active";
      const tierSlug =
        typeof req.query.tier === "string" && req.query.tier.length > 0
          ? req.query.tier
          : undefined;
      const items = listAmbassadors(db, {
        status,
        ...(tierSlug ? { tierSlug } : {}),
        limit,
        offset,
      });
      res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
      res.json({
        limit,
        offset,
        items: items.map(publicAmbassadorView),
      });
    }),
  );

  router.get(
    "/ambassadors/tiers",
    asyncHandler((_req, res) => {
      const tiers = listTiers(db);
      res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
      res.json({ tiers });
    }),
  );

  router.get(
    "/ambassadors/leaderboard",
    asyncHandler((req, res) => {
      const limit = parseIntInRange(req.query.limit, 1, 100, 25);
      const ambassadors = listAmbassadors(db, { status: "active", limit: 500 });
      const enriched = ambassadors.map((a) => ({
        ambassador: publicAmbassadorView(a),
        profile: buildPublicProfile(db, a),
      }));
      enriched.sort((a, b) => {
        const v = b.profile.metrics.totalVolumeUsdc - a.profile.metrics.totalVolumeUsdc;
        if (v !== 0) return v;
        return (
          b.profile.metrics.qualifiedReferrals -
          a.profile.metrics.qualifiedReferrals
        );
      });
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
      res.json({
        limit,
        items: enriched.slice(0, limit).map((e) => e.profile),
      });
    }),
  );

  router.get(
    "/ambassadors/r/:code",
    asyncHandler((req, res, next) => {
      const code = req.params.code?.trim();
      if (!code) return next(HttpError.badRequest("referral code required"));
      const ambassador = getAmbassadorByReferralCode(db, code);
      if (!ambassador || ambassador.status !== "active") {
        return next(HttpError.notFound("referral code not found"));
      }
      res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
      res.json({
        ambassador: publicAmbassadorView(ambassador),
        shareLink: `${siteUrl.replace(/\/+$/, "")}/r/${ambassador.referralCode}`,
      });
    }),
  );

  router.post(
    "/ambassadors/r/:code/click",
    asyncHandler((req, res, next) => {
      const code = req.params.code?.trim();
      if (!code) return next(HttpError.badRequest("referral code required"));
      const parsed = trackClickSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const ambassador = getAmbassadorByReferralCode(db, code);
      if (!ambassador || ambassador.status !== "active") {
        return next(HttpError.notFound("referral code not found"));
      }
      const ua = req.header("user-agent");
      recordReferralClick(db, {
        ambassadorId: ambassador.id,
        referralCode: ambassador.referralCode,
        source: parsed.data.source ?? null,
        userAgent: ua ? ua.slice(0, 500) : null,
      });
      res.status(202).json({ ok: true });
    }),
  );

  router.get(
    "/ambassadors/:handle",
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      if (!handle) return next(HttpError.badRequest("handle required"));
      const ambassador = getAmbassadorByHandle(db, handle);
      if (!ambassador) return next(HttpError.notFound("ambassador not found"));
      res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
      res.json(buildPublicProfile(db, ambassador));
    }),
  );

  router.post(
    "/admin/ambassadors",
    auth,
    asyncHandler((req, res, next) => {
      const parsed = createAmbassadorSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const handle = parsed.data.handle.toLowerCase();
      if (getAmbassadorByHandle(db, handle)) {
        return next(HttpError.conflict("handle already in use"));
      }
      const tierSlug = parsed.data.tierSlug ?? "bronze";
      if (!getTierBySlug(db, tierSlug)) {
        return next(HttpError.badRequest(`unknown tier: ${tierSlug}`));
      }
      let referralCode: string;
      if (parsed.data.referralCode) {
        referralCode = parsed.data.referralCode;
        if (getAmbassadorByReferralCode(db, referralCode)) {
          return next(HttpError.conflict("referral code already in use"));
        }
      } else {
        referralCode = generateReferralCode(handle);
        // 5 retries on the auto-generated path — collisions are vanishingly
        // unlikely, but the unique index would reject anyway.
        for (let i = 0; i < 5; i += 1) {
          if (!getAmbassadorByReferralCode(db, referralCode)) break;
          referralCode = generateReferralCode(handle);
        }
      }
      try {
        const created = createAmbassador(db, {
          id: newId("amb"),
          handle,
          displayName: parsed.data.displayName,
          email: parsed.data.email.toLowerCase(),
          walletAddress: parsed.data.walletAddress ?? null,
          referralCode,
          tierSlug,
          status: parsed.data.status ?? "active",
        });
        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "ambassador.created",
          entityType: "ambassador",
          entityId: created.id,
          payload: {
            handle: created.handle,
            tierSlug: created.tierSlug,
            referralCode: created.referralCode,
          },
        });
        res.status(201).json(created);
      } catch (err) {
        if (
          err instanceof Error &&
          /UNIQUE constraint failed: ambassadors\.(referral_code|email)/.test(
            err.message,
          )
        ) {
          return next(HttpError.conflict("referral code or email already in use"));
        }
        throw err;
      }
    }),
  );

  router.patch(
    "/admin/ambassadors/:handle",
    auth,
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      if (!handle) return next(HttpError.badRequest("handle required"));
      const parsed = updateAmbassadorSchema.safeParse(req.body);
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const before = getAmbassadorByHandle(db, handle);
      if (!before) return next(HttpError.notFound("ambassador not found"));
      if (parsed.data.tierSlug && !getTierBySlug(db, parsed.data.tierSlug)) {
        return next(HttpError.badRequest(`unknown tier: ${parsed.data.tierSlug}`));
      }
      const updated = updateAmbassador(db, before.id, {
        ...(parsed.data.displayName !== undefined
          ? { displayName: parsed.data.displayName }
          : {}),
        ...(parsed.data.walletAddress !== undefined
          ? { walletAddress: parsed.data.walletAddress }
          : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.tierSlug !== undefined
          ? { tierSlug: parsed.data.tierSlug }
          : {}),
      });
      if (!updated) return next(HttpError.notFound("ambassador not found"));
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "ambassador.updated",
        entityType: "ambassador",
        entityId: updated.id,
        payload: {
          before: { tierSlug: before.tierSlug, status: before.status },
          after: { tierSlug: updated.tierSlug, status: updated.status },
        },
      });
      res.json(updated);
    }),
  );

  router.get(
    "/admin/ambassadors/:handle/dashboard",
    auth,
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      if (!handle) return next(HttpError.badRequest("handle required"));
      const ambassador = getAmbassadorByHandle(db, handle);
      if (!ambassador) return next(HttpError.notFound("ambassador not found"));
      const dashboard = buildDashboard(db, ambassador, { siteUrl });
      res.json(dashboard);
    }),
  );

  router.post(
    "/admin/ambassadors/:handle/referrals",
    auth,
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      if (!handle) return next(HttpError.badRequest("handle required"));
      const parsed = createReferralSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const ambassador = getAmbassadorByHandle(db, handle);
      if (!ambassador) return next(HttpError.notFound("ambassador not found"));
      if (
        parsed.data.referredMerchantId &&
        !findMerchantById(db, parsed.data.referredMerchantId)
      ) {
        return next(
          HttpError.badRequest(
            `unknown merchant: ${parsed.data.referredMerchantId}`,
          ),
        );
      }
      try {
        const referral = createReferral(db, {
          id: newId("ref"),
          ambassadorId: ambassador.id,
          referredMerchantId: parsed.data.referredMerchantId ?? null,
          referredLabel: parsed.data.referredLabel ?? null,
          source: parsed.data.source ?? "manual",
          status: parsed.data.status ?? "pending",
          volumeUsdc: parsed.data.volumeUsdc ?? 0,
        });
        const recompute = recomputeAmbassadorTier(db, ambassador.id);
        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "ambassador_referral.created",
          entityType: "ambassador_referral",
          entityId: referral.id,
          payload: {
            ambassadorId: ambassador.id,
            handle: ambassador.handle,
            status: referral.status,
            volumeUsdc: referral.volumeUsdc,
            promoted: recompute?.promoted ?? false,
            tierTransition:
              recompute && recompute.promoted
                ? { from: recompute.previousTierSlug, to: recompute.newTierSlug }
                : null,
          },
        });
        res.status(201).json({
          referral,
          ambassador: recompute?.ambassador ?? ambassador,
          promoted: recompute?.promoted ?? false,
        });
      } catch (err) {
        if (
          err instanceof Error &&
          /UNIQUE constraint failed: ambassador_referrals/.test(err.message)
        ) {
          return next(
            HttpError.conflict("merchant already attributed to this ambassador"),
          );
        }
        throw err;
      }
    }),
  );

  router.patch(
    "/admin/ambassadors/:handle/referrals/:id",
    auth,
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      const referralId = req.params.id?.trim();
      if (!handle) return next(HttpError.badRequest("handle required"));
      if (!referralId) return next(HttpError.badRequest("referral id required"));
      const parsed = updateReferralSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const ambassador = getAmbassadorByHandle(db, handle);
      if (!ambassador) return next(HttpError.notFound("ambassador not found"));
      const before = getReferralById(db, referralId);
      if (!before || before.ambassadorId !== ambassador.id) {
        return next(HttpError.notFound("referral not found"));
      }
      const updated = updateReferral(db, referralId, {
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.volumeUsdc !== undefined
          ? { volumeUsdc: parsed.data.volumeUsdc }
          : {}),
        ...(parsed.data.referredMerchantId !== undefined
          ? { referredMerchantId: parsed.data.referredMerchantId }
          : {}),
        ...(parsed.data.referredLabel !== undefined
          ? { referredLabel: parsed.data.referredLabel }
          : {}),
      });
      if (!updated) return next(HttpError.notFound("referral not found"));
      const recompute = recomputeAmbassadorTier(db, ambassador.id);
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "ambassador_referral.updated",
        entityType: "ambassador_referral",
        entityId: referralId,
        payload: {
          before: { status: before.status, volumeUsdc: before.volumeUsdc },
          after: { status: updated.status, volumeUsdc: updated.volumeUsdc },
          promoted: recompute?.promoted ?? false,
          tierTransition:
            recompute && recompute.promoted
              ? { from: recompute.previousTierSlug, to: recompute.newTierSlug }
              : null,
        },
      });
      res.json({
        referral: updated,
        ambassador: recompute?.ambassador ?? ambassador,
        promoted: recompute?.promoted ?? false,
      });
    }),
  );

  router.post(
    "/admin/ambassadors/:handle/perks/:perkKey/redeem",
    auth,
    asyncHandler((req, res, next) => {
      const handle = req.params.handle?.trim().toLowerCase();
      const perkKey = req.params.perkKey?.trim();
      if (!handle) return next(HttpError.badRequest("handle required"));
      if (!perkKey || !PERK_KEY_REGEX.test(perkKey)) {
        return next(HttpError.badRequest("invalid perk key"));
      }
      const parsed = redeemPerkSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const ambassador = getAmbassadorByHandle(db, handle);
      if (!ambassador) return next(HttpError.notFound("ambassador not found"));
      const tier = getTierBySlug(db, ambassador.tierSlug);
      if (!tier || !tier.perks.includes(perkKey)) {
        return next(
          HttpError.forbidden(
            `perk ${perkKey} is not available for tier ${ambassador.tierSlug}`,
          ),
        );
      }
      try {
        const perk = redeemPerk(db, {
          id: newId("prk"),
          ambassadorId: ambassador.id,
          perkKey,
          metadata: parsed.data.metadata ?? null,
        });
        appendAudit(db, {
          actor: req.admin?.adminActor ?? "admin",
          event: "ambassador_perk.redeemed",
          entityType: "ambassador",
          entityId: ambassador.id,
          payload: { perkKey, tierSlug: ambassador.tierSlug },
        });
        res.status(201).json(perk);
      } catch (err) {
        if (
          err instanceof Error &&
          /UNIQUE constraint failed: ambassador_perks/.test(err.message)
        ) {
          return next(HttpError.conflict("perk already redeemed"));
        }
        throw err;
      }
    }),
  );

  router.patch(
    "/admin/ambassador-tiers/:slug",
    auth,
    asyncHandler((req, res, next) => {
      const slug = req.params.slug?.trim();
      if (!slug) return next(HttpError.badRequest("tier slug required"));
      const parsed = patchTierSchema.safeParse(req.body ?? {});
      if (!parsed.success) return next(badRequestFromZod(parsed.error));
      const before = getTierBySlug(db, slug);
      if (!before) return next(HttpError.notFound("tier not found"));
      const updated = patchTier(db, {
        slug,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.position !== undefined
          ? { position: parsed.data.position }
          : {}),
        ...(parsed.data.minQualifiedReferrals !== undefined
          ? { minQualifiedReferrals: parsed.data.minQualifiedReferrals }
          : {}),
        ...(parsed.data.minVolumeUsdc !== undefined
          ? { minVolumeUsdc: parsed.data.minVolumeUsdc }
          : {}),
        ...(parsed.data.description !== undefined
          ? { description: parsed.data.description }
          : {}),
        ...(parsed.data.perks !== undefined ? { perks: parsed.data.perks } : {}),
      });
      if (!updated) return next(HttpError.notFound("tier not found"));
      appendAudit(db, {
        actor: req.admin?.adminActor ?? "admin",
        event: "ambassador_tier.updated",
        entityType: "ambassador_tier",
        entityId: slug,
        payload: {
          before: {
            minQualifiedReferrals: before.minQualifiedReferrals,
            minVolumeUsdc: before.minVolumeUsdc,
            perks: before.perks,
          },
          after: {
            minQualifiedReferrals: updated.minQualifiedReferrals,
            minVolumeUsdc: updated.minVolumeUsdc,
            perks: updated.perks,
          },
        },
      });
      res.json(updated);
    }),
  );

  return router;
}

function parseIntInRange(
  raw: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined || raw === null) return fallback;
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value)) return fallback;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export type { Ambassador };
export { getAmbassadorById };
