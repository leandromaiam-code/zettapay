import type { Database as Db } from "better-sqlite3";

export type AmbassadorStatus = "active" | "inactive" | "suspended";
export type ReferralStatus = "pending" | "qualified";
export type ReferralSource = "signup" | "manual" | "payment";

export interface AmbassadorTierRow {
  slug: string;
  name: string;
  position: number;
  min_qualified_referrals: number;
  min_volume_usdc: number;
  description: string | null;
  perks_json: string;
  created_at: string;
  updated_at: string;
}

export interface AmbassadorTier {
  slug: string;
  name: string;
  position: number;
  minQualifiedReferrals: number;
  minVolumeUsdc: number;
  description: string | null;
  perks: string[];
  createdAt: string;
  updatedAt: string;
}

export interface AmbassadorRow {
  id: string;
  handle: string;
  display_name: string;
  email: string;
  wallet_address: string | null;
  referral_code: string;
  tier_slug: string;
  status: AmbassadorStatus;
  joined_at: string;
  updated_at: string;
}

export interface Ambassador {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  walletAddress: string | null;
  referralCode: string;
  tierSlug: string;
  status: AmbassadorStatus;
  joinedAt: string;
  updatedAt: string;
}

export interface AmbassadorReferralRow {
  id: string;
  ambassador_id: string;
  referred_merchant_id: string | null;
  referred_label: string | null;
  source: ReferralSource;
  status: ReferralStatus;
  volume_usdc: number;
  qualified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AmbassadorReferral {
  id: string;
  ambassadorId: string;
  referredMerchantId: string | null;
  referredLabel: string | null;
  source: ReferralSource;
  status: ReferralStatus;
  volumeUsdc: number;
  qualifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AmbassadorPerkRow {
  id: string;
  ambassador_id: string;
  perk_key: string;
  metadata_json: string | null;
  redeemed_at: string;
}

export interface AmbassadorPerk {
  id: string;
  ambassadorId: string;
  perkKey: string;
  metadata: Record<string, unknown> | null;
  redeemedAt: string;
}

export interface AmbassadorReferralClickRow {
  id: number;
  ambassador_id: string;
  referral_code: string;
  source: string | null;
  user_agent: string | null;
  created_at: string;
}

/**
 * Z19.4 ambassadors — tier system + referral tracking + perks.
 *
 * Tiers are seeded with a sensible default (bronze→silver→gold→diamond) on
 * first init; admins can edit them via PATCH /admin/ambassador-tiers/:slug.
 * Tier promotion is recomputed on every referral state change so we never
 * surface a stale tier — see recomputeAmbassadorTier().
 */
export function ensureAmbassadorsSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ambassador_tiers (
      slug                     TEXT PRIMARY KEY,
      name                     TEXT NOT NULL,
      position                 INTEGER NOT NULL UNIQUE,
      min_qualified_referrals  INTEGER NOT NULL DEFAULT 0,
      min_volume_usdc          REAL NOT NULL DEFAULT 0,
      description              TEXT,
      perks_json               TEXT NOT NULL DEFAULT '[]',
      created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS ambassador_tiers_position_idx
      ON ambassador_tiers(position);

    CREATE TABLE IF NOT EXISTS ambassadors (
      id              TEXT PRIMARY KEY,
      handle          TEXT NOT NULL UNIQUE,
      display_name    TEXT NOT NULL,
      email           TEXT NOT NULL UNIQUE,
      wallet_address  TEXT,
      referral_code   TEXT NOT NULL UNIQUE,
      tier_slug       TEXT NOT NULL REFERENCES ambassador_tiers(slug) ON DELETE RESTRICT,
      status          TEXT NOT NULL CHECK (status IN ('active','inactive','suspended')) DEFAULT 'active',
      joined_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS ambassadors_tier_idx ON ambassadors(tier_slug);
    CREATE INDEX IF NOT EXISTS ambassadors_status_idx ON ambassadors(status);

    CREATE TABLE IF NOT EXISTS ambassador_referrals (
      id                    TEXT PRIMARY KEY,
      ambassador_id         TEXT NOT NULL REFERENCES ambassadors(id) ON DELETE CASCADE,
      referred_merchant_id  TEXT REFERENCES merchants(id) ON DELETE SET NULL,
      referred_label        TEXT,
      source                TEXT NOT NULL CHECK (source IN ('signup','manual','payment')) DEFAULT 'manual',
      status                TEXT NOT NULL CHECK (status IN ('pending','qualified')) DEFAULT 'pending',
      volume_usdc           REAL NOT NULL DEFAULT 0,
      qualified_at          TEXT,
      created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS ambassador_referrals_ambassador_idx
      ON ambassador_referrals(ambassador_id, created_at);
    CREATE INDEX IF NOT EXISTS ambassador_referrals_status_idx
      ON ambassador_referrals(ambassador_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS ambassador_referrals_merchant_uidx
      ON ambassador_referrals(ambassador_id, referred_merchant_id)
      WHERE referred_merchant_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS ambassador_perks (
      id              TEXT PRIMARY KEY,
      ambassador_id   TEXT NOT NULL REFERENCES ambassadors(id) ON DELETE CASCADE,
      perk_key        TEXT NOT NULL,
      metadata_json   TEXT,
      redeemed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS ambassador_perks_uidx
      ON ambassador_perks(ambassador_id, perk_key);

    CREATE TABLE IF NOT EXISTS ambassador_referral_clicks (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      ambassador_id   TEXT NOT NULL REFERENCES ambassadors(id) ON DELETE CASCADE,
      referral_code   TEXT NOT NULL,
      source          TEXT,
      user_agent      TEXT,
      created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS ambassador_referral_clicks_ambassador_idx
      ON ambassador_referral_clicks(ambassador_id, created_at);
    CREATE INDEX IF NOT EXISTS ambassador_referral_clicks_code_idx
      ON ambassador_referral_clicks(referral_code, created_at);
  `);

  seedDefaultTiers(db);
}

const DEFAULT_TIERS: ReadonlyArray<{
  slug: string;
  name: string;
  position: number;
  minQualifiedReferrals: number;
  minVolumeUsdc: number;
  description: string;
  perks: string[];
}> = [
  {
    slug: "bronze",
    name: "Bronze",
    position: 1,
    minQualifiedReferrals: 0,
    minVolumeUsdc: 0,
    description: "Starter tier — assigned automatically when a new ambassador joins.",
    perks: ["referral_link", "ambassador_role_discord"],
  },
  {
    slug: "silver",
    name: "Silver",
    position: 2,
    minQualifiedReferrals: 3,
    minVolumeUsdc: 5_000,
    description: "Active ambassadors with at least three qualified referrals.",
    perks: [
      "referral_link",
      "ambassador_role_discord",
      "early_access_features",
      "branded_swag",
    ],
  },
  {
    slug: "gold",
    name: "Gold",
    position: 3,
    minQualifiedReferrals: 10,
    minVolumeUsdc: 50_000,
    description: "Top contributors driving meaningful volume to the protocol.",
    perks: [
      "referral_link",
      "ambassador_role_discord",
      "early_access_features",
      "branded_swag",
      "monthly_office_hours",
      "co_marketing_features",
    ],
  },
  {
    slug: "diamond",
    name: "Diamond",
    position: 4,
    minQualifiedReferrals: 25,
    minVolumeUsdc: 250_000,
    description: "Inner-circle partners. Direct line to the core team.",
    perks: [
      "referral_link",
      "ambassador_role_discord",
      "early_access_features",
      "branded_swag",
      "monthly_office_hours",
      "co_marketing_features",
      "revenue_share_pilot",
      "private_signal_channel",
    ],
  },
];

function seedDefaultTiers(db: Db): void {
  const existing = db
    .prepare("SELECT COUNT(*) AS n FROM ambassador_tiers")
    .get() as { n: number };
  if (existing.n > 0) return;
  const insert = db.prepare<
    [string, string, number, number, number, string, string]
  >(
    `INSERT INTO ambassador_tiers
       (slug, name, position, min_qualified_referrals, min_volume_usdc, description, perks_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    for (const tier of DEFAULT_TIERS) {
      insert.run(
        tier.slug,
        tier.name,
        tier.position,
        tier.minQualifiedReferrals,
        tier.minVolumeUsdc,
        tier.description,
        JSON.stringify(tier.perks),
      );
    }
  });
  tx();
}

function toTier(row: AmbassadorTierRow): AmbassadorTier {
  let perks: string[];
  try {
    const parsed: unknown = JSON.parse(row.perks_json);
    perks = Array.isArray(parsed)
      ? parsed.filter((p): p is string => typeof p === "string")
      : [];
  } catch {
    perks = [];
  }
  return {
    slug: row.slug,
    name: row.name,
    position: row.position,
    minQualifiedReferrals: row.min_qualified_referrals,
    minVolumeUsdc: row.min_volume_usdc,
    description: row.description,
    perks,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAmbassador(row: AmbassadorRow): Ambassador {
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    email: row.email,
    walletAddress: row.wallet_address,
    referralCode: row.referral_code,
    tierSlug: row.tier_slug,
    status: row.status,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
  };
}

function toReferral(row: AmbassadorReferralRow): AmbassadorReferral {
  return {
    id: row.id,
    ambassadorId: row.ambassador_id,
    referredMerchantId: row.referred_merchant_id,
    referredLabel: row.referred_label,
    source: row.source,
    status: row.status,
    volumeUsdc: row.volume_usdc,
    qualifiedAt: row.qualified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPerk(row: AmbassadorPerkRow): AmbassadorPerk {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata_json) {
    try {
      const parsed: unknown = JSON.parse(row.metadata_json);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = null;
    }
  }
  return {
    id: row.id,
    ambassadorId: row.ambassador_id,
    perkKey: row.perk_key,
    metadata,
    redeemedAt: row.redeemed_at,
  };
}

export function listTiers(db: Db): AmbassadorTier[] {
  ensureAmbassadorsSchema(db);
  const rows = db
    .prepare("SELECT * FROM ambassador_tiers ORDER BY position ASC")
    .all() as AmbassadorTierRow[];
  return rows.map(toTier);
}

export function getTierBySlug(db: Db, slug: string): AmbassadorTier | null {
  const row = db
    .prepare<[string]>("SELECT * FROM ambassador_tiers WHERE slug = ?")
    .get(slug) as AmbassadorTierRow | undefined;
  return row ? toTier(row) : null;
}

export interface UpsertTierInput {
  slug: string;
  name?: string;
  position?: number;
  minQualifiedReferrals?: number;
  minVolumeUsdc?: number;
  description?: string | null;
  perks?: string[];
}

export function patchTier(db: Db, input: UpsertTierInput): AmbassadorTier | null {
  const existing = getTierBySlug(db, input.slug);
  if (!existing) return null;
  const next = {
    name: input.name ?? existing.name,
    position: input.position ?? existing.position,
    minQualifiedReferrals:
      input.minQualifiedReferrals ?? existing.minQualifiedReferrals,
    minVolumeUsdc: input.minVolumeUsdc ?? existing.minVolumeUsdc,
    description:
      input.description === undefined ? existing.description : input.description,
    perks: input.perks ?? existing.perks,
  };
  db.prepare<[string, number, number, number, string | null, string, string, string]>(
    `UPDATE ambassador_tiers
        SET name = ?, position = ?, min_qualified_referrals = ?, min_volume_usdc = ?,
            description = ?, perks_json = ?, updated_at = ?
      WHERE slug = ?`,
  ).run(
    next.name,
    next.position,
    next.minQualifiedReferrals,
    next.minVolumeUsdc,
    next.description,
    JSON.stringify(next.perks),
    new Date().toISOString(),
    input.slug,
  );
  return getTierBySlug(db, input.slug);
}

export interface CreateAmbassadorInput {
  id: string;
  handle: string;
  displayName: string;
  email: string;
  walletAddress?: string | null;
  referralCode: string;
  tierSlug?: string;
  status?: AmbassadorStatus;
}

export function createAmbassador(
  db: Db,
  input: CreateAmbassadorInput,
): Ambassador {
  ensureAmbassadorsSchema(db);
  const tierSlug = input.tierSlug ?? "bronze";
  if (!getTierBySlug(db, tierSlug)) {
    throw new Error(`unknown tier slug: ${tierSlug}`);
  }
  db.prepare<
    [
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      AmbassadorStatus,
    ]
  >(
    `INSERT INTO ambassadors
       (id, handle, display_name, email, wallet_address, referral_code, tier_slug, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.handle,
    input.displayName,
    input.email,
    input.walletAddress ?? null,
    input.referralCode,
    tierSlug,
    input.status ?? "active",
  );
  return getAmbassadorById(db, input.id)!;
}

export interface UpdateAmbassadorInput {
  displayName?: string;
  walletAddress?: string | null;
  status?: AmbassadorStatus;
  tierSlug?: string;
}

export function updateAmbassador(
  db: Db,
  id: string,
  patch: UpdateAmbassadorInput,
): Ambassador | null {
  const existing = getAmbassadorById(db, id);
  if (!existing) return null;
  const next = {
    displayName: patch.displayName ?? existing.displayName,
    walletAddress:
      patch.walletAddress === undefined
        ? existing.walletAddress
        : patch.walletAddress,
    status: patch.status ?? existing.status,
    tierSlug: patch.tierSlug ?? existing.tierSlug,
  };
  if (patch.tierSlug && !getTierBySlug(db, patch.tierSlug)) {
    throw new Error(`unknown tier slug: ${patch.tierSlug}`);
  }
  db.prepare<
    [string, string | null, AmbassadorStatus, string, string, string]
  >(
    `UPDATE ambassadors
        SET display_name = ?, wallet_address = ?, status = ?, tier_slug = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    next.displayName,
    next.walletAddress,
    next.status,
    next.tierSlug,
    new Date().toISOString(),
    id,
  );
  return getAmbassadorById(db, id);
}

export function getAmbassadorById(db: Db, id: string): Ambassador | null {
  const row = db
    .prepare<[string]>("SELECT * FROM ambassadors WHERE id = ?")
    .get(id) as AmbassadorRow | undefined;
  return row ? toAmbassador(row) : null;
}

export function getAmbassadorByHandle(
  db: Db,
  handle: string,
): Ambassador | null {
  const row = db
    .prepare<[string]>("SELECT * FROM ambassadors WHERE handle = ?")
    .get(handle) as AmbassadorRow | undefined;
  return row ? toAmbassador(row) : null;
}

export function getAmbassadorByReferralCode(
  db: Db,
  code: string,
): Ambassador | null {
  const row = db
    .prepare<[string]>("SELECT * FROM ambassadors WHERE referral_code = ?")
    .get(code) as AmbassadorRow | undefined;
  return row ? toAmbassador(row) : null;
}

export interface ListAmbassadorsOptions {
  status?: AmbassadorStatus;
  tierSlug?: string;
  limit?: number;
  offset?: number;
}

export function listAmbassadors(
  db: Db,
  options: ListAmbassadorsOptions = {},
): Ambassador[] {
  ensureAmbassadorsSchema(db);
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const offset = Math.max(0, options.offset ?? 0);
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (options.status) {
    clauses.push("status = ?");
    params.push(options.status);
  }
  if (options.tierSlug) {
    clauses.push("tier_slug = ?");
    params.push(options.tierSlug);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(limit, offset);
  const rows = db
    .prepare(
      `SELECT * FROM ambassadors ${where} ORDER BY joined_at DESC LIMIT ? OFFSET ?`,
    )
    .all(...params) as AmbassadorRow[];
  return rows.map(toAmbassador);
}

export interface CreateReferralInput {
  id: string;
  ambassadorId: string;
  referredMerchantId?: string | null;
  referredLabel?: string | null;
  source?: ReferralSource;
  status?: ReferralStatus;
  volumeUsdc?: number;
}

export function createReferral(
  db: Db,
  input: CreateReferralInput,
): AmbassadorReferral {
  ensureAmbassadorsSchema(db);
  const status = input.status ?? "pending";
  const qualifiedAt = status === "qualified" ? new Date().toISOString() : null;
  db.prepare<
    [
      string,
      string,
      string | null,
      string | null,
      ReferralSource,
      ReferralStatus,
      number,
      string | null,
    ]
  >(
    `INSERT INTO ambassador_referrals
       (id, ambassador_id, referred_merchant_id, referred_label, source, status, volume_usdc, qualified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.ambassadorId,
    input.referredMerchantId ?? null,
    input.referredLabel ?? null,
    input.source ?? "manual",
    status,
    input.volumeUsdc ?? 0,
    qualifiedAt,
  );
  return getReferralById(db, input.id)!;
}

export interface UpdateReferralInput {
  status?: ReferralStatus;
  volumeUsdc?: number;
  referredMerchantId?: string | null;
  referredLabel?: string | null;
}

export function updateReferral(
  db: Db,
  id: string,
  patch: UpdateReferralInput,
): AmbassadorReferral | null {
  const existing = getReferralById(db, id);
  if (!existing) return null;
  const nextStatus = patch.status ?? existing.status;
  const qualifiedAt =
    nextStatus === "qualified" && existing.status !== "qualified"
      ? new Date().toISOString()
      : nextStatus === "qualified"
        ? existing.qualifiedAt
        : null;
  const next = {
    status: nextStatus,
    volumeUsdc:
      patch.volumeUsdc === undefined ? existing.volumeUsdc : patch.volumeUsdc,
    referredMerchantId:
      patch.referredMerchantId === undefined
        ? existing.referredMerchantId
        : patch.referredMerchantId,
    referredLabel:
      patch.referredLabel === undefined
        ? existing.referredLabel
        : patch.referredLabel,
  };
  db.prepare<
    [
      ReferralStatus,
      number,
      string | null,
      string | null,
      string | null,
      string,
      string,
    ]
  >(
    `UPDATE ambassador_referrals
        SET status = ?, volume_usdc = ?, referred_merchant_id = ?, referred_label = ?,
            qualified_at = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    next.status,
    next.volumeUsdc,
    next.referredMerchantId,
    next.referredLabel,
    qualifiedAt,
    new Date().toISOString(),
    id,
  );
  return getReferralById(db, id);
}

export function getReferralById(
  db: Db,
  id: string,
): AmbassadorReferral | null {
  const row = db
    .prepare<[string]>("SELECT * FROM ambassador_referrals WHERE id = ?")
    .get(id) as AmbassadorReferralRow | undefined;
  return row ? toReferral(row) : null;
}

export function listReferralsForAmbassador(
  db: Db,
  ambassadorId: string,
  options: { limit?: number; status?: ReferralStatus } = {},
): AmbassadorReferral[] {
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1_000));
  const rows = options.status
    ? (db
        .prepare<[string, ReferralStatus, number]>(
          `SELECT * FROM ambassador_referrals
            WHERE ambassador_id = ? AND status = ?
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(ambassadorId, options.status, limit) as AmbassadorReferralRow[])
    : (db
        .prepare<[string, number]>(
          `SELECT * FROM ambassador_referrals
            WHERE ambassador_id = ?
            ORDER BY created_at DESC
            LIMIT ?`,
        )
        .all(ambassadorId, limit) as AmbassadorReferralRow[]);
  return rows.map(toReferral);
}

export interface AmbassadorMetrics {
  totalReferrals: number;
  qualifiedReferrals: number;
  pendingReferrals: number;
  totalVolumeUsdc: number;
  qualifiedVolumeUsdc: number;
  totalClicks: number;
}

export function metricsForAmbassador(
  db: Db,
  ambassadorId: string,
): AmbassadorMetrics {
  const counts = db
    .prepare<[string]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'qualified' THEN 1 ELSE 0 END) AS qualified,
         SUM(CASE WHEN status = 'pending'   THEN 1 ELSE 0 END) AS pending,
         COALESCE(SUM(volume_usdc), 0) AS volume,
         COALESCE(SUM(CASE WHEN status = 'qualified' THEN volume_usdc ELSE 0 END), 0) AS qualified_volume
       FROM ambassador_referrals
       WHERE ambassador_id = ?`,
    )
    .get(ambassadorId) as
    | {
        total: number;
        qualified: number | null;
        pending: number | null;
        volume: number | null;
        qualified_volume: number | null;
      }
    | undefined;
  const clicks = db
    .prepare<[string]>(
      `SELECT COUNT(*) AS n FROM ambassador_referral_clicks WHERE ambassador_id = ?`,
    )
    .get(ambassadorId) as { n: number };
  return {
    totalReferrals: counts?.total ?? 0,
    qualifiedReferrals: counts?.qualified ?? 0,
    pendingReferrals: counts?.pending ?? 0,
    totalVolumeUsdc: counts?.volume ?? 0,
    qualifiedVolumeUsdc: counts?.qualified_volume ?? 0,
    totalClicks: clicks.n,
  };
}

export function recordReferralClick(
  db: Db,
  input: {
    ambassadorId: string;
    referralCode: string;
    source?: string | null;
    userAgent?: string | null;
  },
): void {
  ensureAmbassadorsSchema(db);
  db.prepare<[string, string, string | null, string | null]>(
    `INSERT INTO ambassador_referral_clicks
       (ambassador_id, referral_code, source, user_agent)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.ambassadorId,
    input.referralCode,
    input.source ?? null,
    input.userAgent ?? null,
  );
}

export interface RedeemPerkInput {
  id: string;
  ambassadorId: string;
  perkKey: string;
  metadata?: Record<string, unknown> | null;
}

export function redeemPerk(
  db: Db,
  input: RedeemPerkInput,
): AmbassadorPerk {
  ensureAmbassadorsSchema(db);
  db.prepare<[string, string, string, string | null]>(
    `INSERT INTO ambassador_perks (id, ambassador_id, perk_key, metadata_json)
     VALUES (?, ?, ?, ?)`,
  ).run(
    input.id,
    input.ambassadorId,
    input.perkKey,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  const row = db
    .prepare<[string]>("SELECT * FROM ambassador_perks WHERE id = ?")
    .get(input.id) as AmbassadorPerkRow;
  return toPerk(row);
}

export function listRedeemedPerks(
  db: Db,
  ambassadorId: string,
): AmbassadorPerk[] {
  const rows = db
    .prepare<[string]>(
      `SELECT * FROM ambassador_perks WHERE ambassador_id = ? ORDER BY redeemed_at DESC`,
    )
    .all(ambassadorId) as AmbassadorPerkRow[];
  return rows.map(toPerk);
}
