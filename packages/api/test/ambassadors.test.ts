import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import express from "express";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  createAmbassador,
  createReferral,
  ensureAmbassadorsSchema,
  getAmbassadorById,
  getAmbassadorByReferralCode,
  getTierBySlug,
  listTiers,
  metricsForAmbassador,
  patchTier,
  updateReferral,
} from "../src/db/ambassadors.js";
import {
  buildDashboard,
  recomputeAmbassadorTier,
  tierForMetrics,
} from "../src/services/ambassadors.js";
import { ambassadorsRouter } from "../src/routes/ambassadors.js";
import { errorHandler } from "../src/middleware/error.js";
import { listAuditEntries } from "../src/db/audit_journal.js";

const ADMIN_KEY = "ambassadors-admin-key-with-enough-length";

function buildApp(db: Db, adminKey: string | null = ADMIN_KEY) {
  const app = express();
  app.use(express.json({ limit: "256kb" }));
  app.use(
    ambassadorsRouter(db, {
      adminKey,
      siteUrl: "https://zettapay.io",
    }),
  );
  app.use(errorHandler);
  return app;
}

async function listen(app: express.Express): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function adminHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    "x-api-key": ADMIN_KEY,
    "x-admin-actor": "tester",
    "content-type": "application/json",
    ...extra,
  };
}

describe("ambassadors · DB layer + tier promotion", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    ensureAmbassadorsSchema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("seeds the four default tiers in ascending position order", () => {
    const tiers = listTiers(db);
    expect(tiers.map((t) => t.slug)).toEqual([
      "bronze",
      "silver",
      "gold",
      "diamond",
    ]);
    expect(tiers[0]!.position).toBe(1);
    expect(tiers.at(-1)!.position).toBe(4);
    expect(tiers[0]!.perks).toContain("referral_link");
    expect(tiers.at(-1)!.perks).toContain("revenue_share_pilot");
  });

  it("tierForMetrics picks the highest tier the ambassador qualifies for", () => {
    const tiers = listTiers(db);
    expect(
      tierForMetrics(tiers, baseMetrics({ qualifiedReferrals: 0, qualifiedVolumeUsdc: 0 }))!
        .slug,
    ).toBe("bronze");
    expect(
      tierForMetrics(
        tiers,
        baseMetrics({ qualifiedReferrals: 4, qualifiedVolumeUsdc: 6_000 }),
      )!.slug,
    ).toBe("silver");
    // Volume met but not enough qualified referrals → stops at bronze
    expect(
      tierForMetrics(
        tiers,
        baseMetrics({ qualifiedReferrals: 1, qualifiedVolumeUsdc: 100_000 }),
      )!.slug,
    ).toBe("bronze");
    expect(
      tierForMetrics(
        tiers,
        baseMetrics({ qualifiedReferrals: 30, qualifiedVolumeUsdc: 300_000 }),
      )!.slug,
    ).toBe("diamond");
  });

  it("recomputeAmbassadorTier promotes when both thresholds clear", () => {
    const ambassador = createAmbassador(db, {
      id: "amb_1",
      handle: "alice",
      displayName: "Alice",
      email: "alice@example.com",
      referralCode: "alice-1",
    });
    expect(ambassador.tierSlug).toBe("bronze");

    // Two qualified referrals — silver requires 3
    for (const id of ["ref_1", "ref_2"]) {
      createReferral(db, {
        id,
        ambassadorId: ambassador.id,
        status: "qualified",
        volumeUsdc: 3_000,
      });
    }
    let result = recomputeAmbassadorTier(db, ambassador.id)!;
    expect(result.promoted).toBe(false);
    expect(result.ambassador.tierSlug).toBe("bronze");

    createReferral(db, {
      id: "ref_3",
      ambassadorId: ambassador.id,
      status: "qualified",
      volumeUsdc: 5_000,
    });
    result = recomputeAmbassadorTier(db, ambassador.id)!;
    expect(result.promoted).toBe(true);
    expect(result.previousTierSlug).toBe("bronze");
    expect(result.newTierSlug).toBe("silver");
    expect(result.ambassador.tierSlug).toBe("silver");

    // Idempotent — calling again does not re-promote
    result = recomputeAmbassadorTier(db, ambassador.id)!;
    expect(result.promoted).toBe(false);
  });

  it("metricsForAmbassador rolls up qualified vs pending separately", () => {
    const ambassador = createAmbassador(db, {
      id: "amb_2",
      handle: "bob",
      displayName: "Bob",
      email: "bob@example.com",
      referralCode: "bob-2",
    });
    createReferral(db, {
      id: "r1",
      ambassadorId: ambassador.id,
      status: "qualified",
      volumeUsdc: 100,
    });
    createReferral(db, {
      id: "r2",
      ambassadorId: ambassador.id,
      status: "pending",
      volumeUsdc: 50,
    });
    const m = metricsForAmbassador(db, ambassador.id);
    expect(m.totalReferrals).toBe(2);
    expect(m.qualifiedReferrals).toBe(1);
    expect(m.pendingReferrals).toBe(1);
    expect(m.totalVolumeUsdc).toBe(150);
    expect(m.qualifiedVolumeUsdc).toBe(100);
  });

  it("updateReferral qualify→pending clears qualified_at", () => {
    const ambassador = createAmbassador(db, {
      id: "amb_3",
      handle: "carol",
      displayName: "Carol",
      email: "carol@example.com",
      referralCode: "carol-3",
    });
    const ref = createReferral(db, {
      id: "r1",
      ambassadorId: ambassador.id,
      status: "qualified",
      volumeUsdc: 100,
    });
    expect(ref.qualifiedAt).not.toBeNull();
    const reverted = updateReferral(db, ref.id, { status: "pending" })!;
    expect(reverted.status).toBe("pending");
    expect(reverted.qualifiedAt).toBeNull();
  });

  it("patchTier overwrites thresholds and perks", () => {
    const updated = patchTier(db, {
      slug: "silver",
      minQualifiedReferrals: 5,
      perks: ["referral_link", "custom_perk"],
    })!;
    expect(updated.minQualifiedReferrals).toBe(5);
    expect(updated.perks).toEqual(["referral_link", "custom_perk"]);
  });
});

describe("ambassadors · service layer", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    ensureAmbassadorsSchema(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("buildDashboard surfaces tier progress, available perks, share link", () => {
    const ambassador = createAmbassador(db, {
      id: "amb_d",
      handle: "dora",
      displayName: "Dora",
      email: "dora@example.com",
      referralCode: "dora-1",
    });
    createReferral(db, {
      id: "rf_1",
      ambassadorId: ambassador.id,
      status: "qualified",
      volumeUsdc: 2_000,
    });
    const dashboard = buildDashboard(db, getAmbassadorById(db, ambassador.id)!, {
      siteUrl: "https://example.test",
    });
    expect(dashboard.metrics.qualifiedReferrals).toBe(1);
    expect(dashboard.tierProgress.current.slug).toBe("bronze");
    expect(dashboard.tierProgress.next?.slug).toBe("silver");
    expect(dashboard.tierProgress.qualifiedReferralsToNext).toBe(2);
    expect(dashboard.tierProgress.volumeUsdcToNext).toBe(3_000);
    expect(dashboard.shareLink).toBe("https://example.test/r/dora-1");
    expect(dashboard.perksAvailable).toContain("referral_link");
  });
});

describe("ambassadors · HTTP routes", () => {
  let db: Db;
  let server: { baseUrl: string; close: () => Promise<void> };

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    server = await listen(buildApp(db));
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("end-to-end: admin creates ambassador, attributes referrals, triggers promotion, audits all", async () => {
    const create = await fetch(`${server.baseUrl}/admin/ambassadors`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        handle: "leandro",
        displayName: "Leandro M.",
        email: "leandro@example.com",
        referralCode: "leandro-zp",
      }),
    });
    expect(create.status).toBe(201);
    const ambassador = (await create.json()) as {
      id: string;
      handle: string;
      tierSlug: string;
      referralCode: string;
    };
    expect(ambassador.tierSlug).toBe("bronze");

    // Public profile reachable by handle
    const profile = await fetch(`${server.baseUrl}/ambassadors/leandro`);
    expect(profile.status).toBe(200);
    const profileBody = (await profile.json()) as Record<string, unknown>;
    expect(profileBody.handle).toBe("leandro");

    // Public referral resolution
    const codeLookup = await fetch(
      `${server.baseUrl}/ambassadors/r/${ambassador.referralCode}`,
    );
    expect(codeLookup.status).toBe(200);
    const codeBody = (await codeLookup.json()) as { shareLink: string };
    expect(codeBody.shareLink).toContain(`/r/${ambassador.referralCode}`);

    // Attribute three qualified referrals → promotes to silver
    let lastBody: Record<string, unknown> = {};
    for (let i = 0; i < 3; i += 1) {
      const resp = await fetch(
        `${server.baseUrl}/admin/ambassadors/leandro/referrals`,
        {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({
            referredLabel: `merchant ${i}`,
            status: "qualified",
            volumeUsdc: 2_500,
          }),
        },
      );
      expect(resp.status).toBe(201);
      lastBody = (await resp.json()) as Record<string, unknown>;
    }
    expect(lastBody.promoted).toBe(true);
    expect((lastBody.ambassador as { tierSlug: string }).tierSlug).toBe(
      "silver",
    );

    // Dashboard reflects new tier + share link
    const dashResp = await fetch(
      `${server.baseUrl}/admin/ambassadors/leandro/dashboard`,
      { headers: adminHeaders() },
    );
    expect(dashResp.status).toBe(200);
    const dashboard = (await dashResp.json()) as {
      shareLink: string;
      tierProgress: { current: { slug: string }; next: { slug: string } | null };
      metrics: { qualifiedReferrals: number };
      perksAvailable: string[];
      recentReferrals: Array<{ id: string }>;
    };
    expect(dashboard.tierProgress.current.slug).toBe("silver");
    expect(dashboard.tierProgress.next?.slug).toBe("gold");
    expect(dashboard.metrics.qualifiedReferrals).toBe(3);
    expect(dashboard.perksAvailable).toContain("branded_swag");
    expect(dashboard.recentReferrals).toHaveLength(3);
    expect(dashboard.shareLink).toBe(
      `https://zettapay.io/r/${ambassador.referralCode}`,
    );

    // Redeem a tier-eligible perk
    const redeem = await fetch(
      `${server.baseUrl}/admin/ambassadors/leandro/perks/branded_swag/redeem`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({ metadata: { size: "M" } }),
      },
    );
    expect(redeem.status).toBe(201);

    // Double redemption is rejected
    const dup = await fetch(
      `${server.baseUrl}/admin/ambassadors/leandro/perks/branded_swag/redeem`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      },
    );
    expect(dup.status).toBe(409);

    // Perk not in tier list is forbidden
    const forbidden = await fetch(
      `${server.baseUrl}/admin/ambassadors/leandro/perks/revenue_share_pilot/redeem`,
      {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({}),
      },
    );
    expect(forbidden.status).toBe(403);

    // Click tracking is public + persists a row
    const click = await fetch(
      `${server.baseUrl}/ambassadors/r/${ambassador.referralCode}/click`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: "twitter" }),
      },
    );
    expect(click.status).toBe(202);

    const dashAfterClick = (await (
      await fetch(`${server.baseUrl}/admin/ambassadors/leandro/dashboard`, {
        headers: adminHeaders(),
      })
    ).json()) as { metrics: { totalClicks: number } };
    expect(dashAfterClick.metrics.totalClicks).toBe(1);

    // Audit trail captures every admin write
    const events = listAuditEntries(db, { limit: 100 }).map((a) => a.event);
    expect(events).toContain("ambassador.created");
    expect(events).toContain("ambassador_referral.created");
    expect(events).toContain("ambassador_perk.redeemed");
    // At least one referral creation logged a tier promotion in its payload
    const promotions = listAuditEntries(db, {
      event: "ambassador_referral.created",
    }).filter((e) => {
      const payload = e.payload as { promoted?: boolean } | null;
      return payload?.promoted === true;
    });
    expect(promotions.length).toBeGreaterThan(0);
  });

  it("admin endpoints reject calls without the admin key", async () => {
    const resp = await fetch(`${server.baseUrl}/admin/ambassadors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: "no-auth",
        displayName: "x",
        email: "x@example.com",
      }),
    });
    expect(resp.status).toBe(401);
  });

  it("public leaderboard sorts by qualified volume descending", async () => {
    const ambassadors = [
      { handle: "low", email: "low@example.com", volume: 100 },
      { handle: "high", email: "high@example.com", volume: 50_000 },
      { handle: "mid", email: "mid@example.com", volume: 5_000 },
    ];
    for (const a of ambassadors) {
      await fetch(`${server.baseUrl}/admin/ambassadors`, {
        method: "POST",
        headers: adminHeaders(),
        body: JSON.stringify({
          handle: a.handle,
          displayName: a.handle,
          email: a.email,
        }),
      });
      await fetch(
        `${server.baseUrl}/admin/ambassadors/${a.handle}/referrals`,
        {
          method: "POST",
          headers: adminHeaders(),
          body: JSON.stringify({
            status: "qualified",
            volumeUsdc: a.volume,
          }),
        },
      );
    }
    const resp = await fetch(`${server.baseUrl}/ambassadors/leaderboard`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      items: Array<{ handle: string; metrics: { totalVolumeUsdc: number } }>;
    };
    expect(body.items.map((i) => i.handle)).toEqual(["high", "mid", "low"]);
  });

  it("admin endpoints hard-fail with config_error when admin key is missing", async () => {
    await server.close();
    closeDatabase();
    db = openDatabase(":memory:");
    server = await listen(buildApp(db, null));
    const resp = await fetch(`${server.baseUrl}/admin/ambassadors`, {
      method: "POST",
      headers: { "x-api-key": "anything", "content-type": "application/json" },
      body: JSON.stringify({
        handle: "x",
        displayName: "x",
        email: "x@example.com",
      }),
    });
    expect(resp.status).toBe(500);
    const body = (await resp.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("config_error");
  });

  it("re-using a referral_code across ambassadors returns conflict", async () => {
    await fetch(`${server.baseUrl}/admin/ambassadors`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        handle: "first",
        displayName: "First",
        email: "first@example.com",
        referralCode: "duplicate-code",
      }),
    });
    const resp = await fetch(`${server.baseUrl}/admin/ambassadors`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        handle: "second",
        displayName: "Second",
        email: "second@example.com",
        referralCode: "duplicate-code",
      }),
    });
    expect(resp.status).toBe(409);
  });
});

function baseMetrics(overrides: {
  qualifiedReferrals?: number;
  qualifiedVolumeUsdc?: number;
}) {
  return {
    totalReferrals: 0,
    pendingReferrals: 0,
    totalVolumeUsdc: 0,
    totalClicks: 0,
    qualifiedReferrals: overrides.qualifiedReferrals ?? 0,
    qualifiedVolumeUsdc: overrides.qualifiedVolumeUsdc ?? 0,
  };
}

// Silence unused-import warnings — these are checked indirectly.
void getAmbassadorByReferralCode;
void getTierBySlug;
