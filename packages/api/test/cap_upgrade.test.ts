import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { appendAudit, listAuditEntries } from "../src/db/audit_journal.js";
import {
  D30_500_USDC_SCHEDULE,
  D60_REMOVE_CAP_SCHEDULE,
  capUpgradeFiresAt,
  findAppliedCap,
  isCapRemovalSchedule,
  isCapUpgradeDue,
  noopCapBroadcaster,
  runCapUpgrade,
  type CapBroadcaster,
  type CapBroadcastResult,
} from "../src/beta/cap_upgrade.js";
import { startCapUpgradeCron } from "../src/services/cap_upgrade_cron.js";
import type { BetaLaunchConfig } from "../src/beta/config.js";

interface FakeLog {
  debug: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  child: ReturnType<typeof vi.fn>;
}

function makeLogger(): FakeLog {
  const fn = (): FakeLog => log;
  const log: FakeLog = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(fn),
  };
  return log;
}

function makeBetaConfig(launchAt: string | null): BetaLaunchConfig {
  return {
    enabled: true,
    allowlist: new Set<string>(),
    merchantCapUsd: 100,
    maxMerchants: 10,
    launchAt,
    durationDays: 60,
  };
}

const LAUNCH_AT = "2026-05-13T00:00:00.000Z";
const LAUNCH_MS = Date.parse(LAUNCH_AT);
const ONE_DAY = 24 * 60 * 60_000;

function recordingBroadcaster(
  signature = "sig_test_0001",
): { broadcaster: CapBroadcaster; calls: bigint[] } {
  const calls: bigint[] = [];
  const broadcaster: CapBroadcaster = {
    async setMaxInvoiceAmount(amountBaseUnits): Promise<CapBroadcastResult> {
      calls.push(amountBaseUnits);
      return { kind: "ok", signature };
    },
  };
  return { broadcaster, calls };
}

function throwingBroadcaster(message: string): CapBroadcaster {
  return {
    async setMaxInvoiceAmount(): Promise<CapBroadcastResult> {
      throw new Error(message);
    },
  };
}

function seedMerchant(db: Db, id = "m_cap_test"): void {
  db.prepare(
    `INSERT INTO merchants (id, name, wallet_address, email, api_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, "test", "wallet_" + id, id + "@example.com", "k_" + id);
}

function seedFailedPayments(db: Db, merchantId: string, count: number, nowMs: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `pay_fail_${i}`,
      merchantId,
      10,
      "payer_" + i,
      "failed",
      new Date(nowMs - 60_000).toISOString(),
    );
  }
}

function seedCompletedPayments(db: Db, merchantId: string, count: number, nowMs: number): void {
  for (let i = 0; i < count; i += 1) {
    db.prepare(
      `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      `pay_ok_${i}`,
      merchantId,
      10,
      "payer_" + i,
      "completed",
      new Date(nowMs - 60_000).toISOString(),
    );
  }
}

describe("D30_500_USDC_SCHEDULE", () => {
  it("encodes 500 USDC as 500_000_000 base units at 6 decimals", () => {
    expect(D30_500_USDC_SCHEDULE.maxInvoiceBaseUnits).toBe(500_000_000n);
    expect(D30_500_USDC_SCHEDULE.triggerAfterDays).toBe(30);
    expect(D30_500_USDC_SCHEDULE.eventName).toBe(
      "cap_upgrade.set_max_invoice_amount.d30",
    );
  });
});

describe("capUpgradeFiresAt / isCapUpgradeDue", () => {
  it("fires exactly 30 days after launchAt", () => {
    const firesAt = capUpgradeFiresAt(LAUNCH_AT, D30_500_USDC_SCHEDULE);
    expect(Date.parse(firesAt) - LAUNCH_MS).toBe(30 * ONE_DAY);
  });

  it("returns false at D+0", () => {
    expect(isCapUpgradeDue(LAUNCH_AT, D30_500_USDC_SCHEDULE, LAUNCH_MS)).toBe(false);
  });

  it("returns false at D+29 23:59", () => {
    const justBefore = LAUNCH_MS + 30 * ONE_DAY - 60_000;
    expect(isCapUpgradeDue(LAUNCH_AT, D30_500_USDC_SCHEDULE, justBefore)).toBe(false);
  });

  it("returns true at exactly D+30", () => {
    expect(
      isCapUpgradeDue(LAUNCH_AT, D30_500_USDC_SCHEDULE, LAUNCH_MS + 30 * ONE_DAY),
    ).toBe(true);
  });

  it("returns true past D+30", () => {
    expect(
      isCapUpgradeDue(LAUNCH_AT, D30_500_USDC_SCHEDULE, LAUNCH_MS + 31 * ONE_DAY),
    ).toBe(true);
  });
});

describe("runCapUpgrade — orchestrator outcomes", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    seedMerchant(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns no_launch_date when betaConfig.launchAt is null", async () => {
    const { broadcaster, calls } = recordingBroadcaster();
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(null),
      broadcaster,
      now: () => LAUNCH_MS + 31 * ONE_DAY,
    });
    expect(outcome.kind).toBe("no_launch_date");
    expect(calls).toEqual([]);
    expect(listAuditEntries(db)).toHaveLength(0);
  });

  it("returns not_due before D+30 with firesAt at the boundary", async () => {
    const { broadcaster, calls } = recordingBroadcaster();
    const now = LAUNCH_MS + 5 * ONE_DAY;
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      now: () => now,
    });
    expect(outcome.kind).toBe("not_due");
    if (outcome.kind === "not_due") {
      expect(Date.parse(outcome.firesAt) - LAUNCH_MS).toBe(30 * ONE_DAY);
    }
    expect(calls).toEqual([]);
  });

  it("applies the upgrade at D+30 with clean health, writes audit row, calls broadcaster", async () => {
    const { broadcaster, calls } = recordingBroadcaster("sig_d30_ok");
    const log = makeLogger();
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      now: () => LAUNCH_MS + 30 * ONE_DAY,
      logger: log,
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.signature).toBe("sig_d30_ok");
      expect(outcome.amountBaseUnits).toBe(500_000_000n);
      expect(outcome.broadcastSkipped).toBe(false);
      expect(outcome.auditId).toBeGreaterThan(0);
    }
    expect(calls).toEqual([500_000_000n]);

    const rows = listAuditEntries(db, {
      event: D30_500_USDC_SCHEDULE.eventName,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("fabric.cap_upgrade");
    expect(rows[0]!.entityType).toBe("program");
    expect(rows[0]!.entityId).toBe("500000000");
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.amountBaseUnits).toBe("500000000");
    expect(payload.amountUsd).toBe(500);
    expect(payload.signature).toBe("sig_d30_ok");
    expect(payload.broadcastSkipped).toBe(false);
    expect(payload.decimals).toBe(6);
  });

  it("is idempotent — second run after success returns already_applied without re-broadcasting", async () => {
    const { broadcaster, calls } = recordingBroadcaster();
    const cfg = makeBetaConfig(LAUNCH_AT);
    const now = () => LAUNCH_MS + 31 * ONE_DAY;
    const first = await runCapUpgrade({ db, betaConfig: cfg, broadcaster, now });
    expect(first.kind).toBe("applied");

    const second = await runCapUpgrade({ db, betaConfig: cfg, broadcaster, now });
    expect(second.kind).toBe("already_applied");
    if (second.kind === "already_applied") {
      expect(second.amountBaseUnits).toBe(500_000_000n);
      expect(second.appliedAt).toBeDefined();
    }
    expect(calls).toEqual([500_000_000n]);
  });

  it("blocks on critical health alerts and does not broadcast or write audit", async () => {
    const nowMs = LAUNCH_MS + 30 * ONE_DAY;
    seedCompletedPayments(db, "m_cap_test", 30, nowMs);
    seedFailedPayments(db, "m_cap_test", 10, nowMs);

    const { broadcaster, calls } = recordingBroadcaster();
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      now: () => nowMs,
    });
    expect(outcome.kind).toBe("blocked_health");
    if (outcome.kind === "blocked_health") {
      expect(outcome.alerts.length).toBeGreaterThan(0);
      const kinds = outcome.alerts.map((a) => a.kind);
      expect(kinds).toContain("error_rate");
    }
    expect(calls).toEqual([]);
    expect(
      listAuditEntries(db, { event: D30_500_USDC_SCHEDULE.eventName }),
    ).toHaveLength(0);
  });

  it("returns broadcast_failed when broadcaster throws and does not write audit", async () => {
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster: throwingBroadcaster("rpc 503"),
      now: () => LAUNCH_MS + 31 * ONE_DAY,
    });
    expect(outcome.kind).toBe("broadcast_failed");
    if (outcome.kind === "broadcast_failed") {
      expect(outcome.error).toBe("rpc 503");
    }
    expect(
      listAuditEntries(db, { event: D30_500_USDC_SCHEDULE.eventName }),
    ).toHaveLength(0);
  });

  it("retries after a transient broadcast failure on the next tick", async () => {
    const cfg = makeBetaConfig(LAUNCH_AT);
    const now = () => LAUNCH_MS + 31 * ONE_DAY;

    const failed = await runCapUpgrade({
      db,
      betaConfig: cfg,
      broadcaster: throwingBroadcaster("rpc timeout"),
      now,
    });
    expect(failed.kind).toBe("broadcast_failed");

    const { broadcaster, calls } = recordingBroadcaster("sig_retry");
    const ok = await runCapUpgrade({ db, betaConfig: cfg, broadcaster, now });
    expect(ok.kind).toBe("applied");
    expect(calls).toEqual([500_000_000n]);
  });

  it("accepts the noop broadcaster — records the intent with broadcastSkipped=true", async () => {
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster: noopCapBroadcaster(),
      now: () => LAUNCH_MS + 30 * ONE_DAY,
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.signature).toBeNull();
      expect(outcome.broadcastSkipped).toBe(true);
    }
    const rows = listAuditEntries(db, {
      event: D30_500_USDC_SCHEDULE.eventName,
    });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.broadcastSkipped).toBe(true);
    expect(payload.signature).toBeNull();
  });

  it("findAppliedCap returns the audit row payload shape", async () => {
    appendAudit(db, {
      actor: "fabric.cap_upgrade",
      event: D30_500_USDC_SCHEDULE.eventName,
      entityType: "program",
      entityId: "500000000",
      payload: {
        amountBaseUnits: "500000000",
        signature: "sig_seeded",
        broadcastSkipped: false,
      },
    });
    const applied = findAppliedCap(db, D30_500_USDC_SCHEDULE);
    expect(applied).not.toBeNull();
    expect(applied!.amountBaseUnits).toBe(500_000_000n);
    expect(applied!.signature).toBe("sig_seeded");
    expect(applied!.broadcastSkipped).toBe(false);
  });
});

describe("D60_REMOVE_CAP_SCHEDULE (Z30.5)", () => {
  it("encodes cap removal as 0n at the D+60 boundary", () => {
    expect(D60_REMOVE_CAP_SCHEDULE.maxInvoiceBaseUnits).toBe(0n);
    expect(D60_REMOVE_CAP_SCHEDULE.triggerAfterDays).toBe(60);
    expect(D60_REMOVE_CAP_SCHEDULE.eventName).toBe(
      "cap_upgrade.set_max_invoice_amount.d60_remove",
    );
  });

  it("isCapRemovalSchedule flags D+60 but not D+30", () => {
    expect(isCapRemovalSchedule(D60_REMOVE_CAP_SCHEDULE)).toBe(true);
    expect(isCapRemovalSchedule(D30_500_USDC_SCHEDULE)).toBe(false);
  });

  it("fires exactly 60 days after launchAt", () => {
    const firesAt = capUpgradeFiresAt(LAUNCH_AT, D60_REMOVE_CAP_SCHEDULE);
    expect(Date.parse(firesAt) - LAUNCH_MS).toBe(60 * ONE_DAY);
  });

  it("returns false at D+30 (D+60 not due yet)", () => {
    expect(
      isCapUpgradeDue(LAUNCH_AT, D60_REMOVE_CAP_SCHEDULE, LAUNCH_MS + 30 * ONE_DAY),
    ).toBe(false);
  });

  it("returns true at exactly D+60", () => {
    expect(
      isCapUpgradeDue(LAUNCH_AT, D60_REMOVE_CAP_SCHEDULE, LAUNCH_MS + 60 * ONE_DAY),
    ).toBe(true);
  });
});

describe("runCapUpgrade — D+60 cap removal (Z30.5)", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    seedMerchant(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("not_due at D+30 — D+60 has not yet arrived", async () => {
    const { broadcaster, calls } = recordingBroadcaster();
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      schedule: D60_REMOVE_CAP_SCHEDULE,
      now: () => LAUNCH_MS + 30 * ONE_DAY,
    });
    expect(outcome.kind).toBe("not_due");
    expect(calls).toEqual([]);
    expect(listAuditEntries(db)).toHaveLength(0);
  });

  it("applies cap removal at D+60 with clean health — broadcasts 0n, audit has capRemoved=true", async () => {
    const { broadcaster, calls } = recordingBroadcaster("sig_d60_remove");
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      schedule: D60_REMOVE_CAP_SCHEDULE,
      now: () => LAUNCH_MS + 60 * ONE_DAY,
    });
    expect(outcome.kind).toBe("applied");
    if (outcome.kind === "applied") {
      expect(outcome.signature).toBe("sig_d60_remove");
      expect(outcome.amountBaseUnits).toBe(0n);
      expect(outcome.broadcastSkipped).toBe(false);
    }
    expect(calls).toEqual([0n]);

    const rows = listAuditEntries(db, {
      event: D60_REMOVE_CAP_SCHEDULE.eventName,
    });
    expect(rows).toHaveLength(1);
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.amountBaseUnits).toBe("0");
    expect(payload.amountUsd).toBe(0);
    expect(payload.capRemoved).toBe(true);
    expect(payload.signature).toBe("sig_d60_remove");
  });

  it("D+30 audit payload reports capRemoved=false", async () => {
    const { broadcaster } = recordingBroadcaster("sig_d30");
    await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      schedule: D30_500_USDC_SCHEDULE,
      now: () => LAUNCH_MS + 30 * ONE_DAY,
    });
    const rows = listAuditEntries(db, {
      event: D30_500_USDC_SCHEDULE.eventName,
    });
    const payload = rows[0]!.payload as Record<string, unknown>;
    expect(payload.capRemoved).toBe(false);
  });

  it("blocks D+60 fail-closed when program-health alerts are firing", async () => {
    const nowMs = LAUNCH_MS + 60 * ONE_DAY;
    seedCompletedPayments(db, "m_cap_test", 30, nowMs);
    seedFailedPayments(db, "m_cap_test", 10, nowMs);

    const { broadcaster, calls } = recordingBroadcaster();
    const outcome = await runCapUpgrade({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      schedule: D60_REMOVE_CAP_SCHEDULE,
      now: () => nowMs,
    });
    expect(outcome.kind).toBe("blocked_health");
    expect(calls).toEqual([]);
    expect(
      listAuditEntries(db, { event: D60_REMOVE_CAP_SCHEDULE.eventName }),
    ).toHaveLength(0);
  });

  it("D+30 and D+60 audit rows coexist with distinct idempotency keys", async () => {
    const cfg = makeBetaConfig(LAUNCH_AT);
    const { broadcaster: bD30 } = recordingBroadcaster("sig_d30");
    await runCapUpgrade({
      db,
      betaConfig: cfg,
      broadcaster: bD30,
      schedule: D30_500_USDC_SCHEDULE,
      now: () => LAUNCH_MS + 30 * ONE_DAY,
    });
    const { broadcaster: bD60 } = recordingBroadcaster("sig_d60");
    await runCapUpgrade({
      db,
      betaConfig: cfg,
      broadcaster: bD60,
      schedule: D60_REMOVE_CAP_SCHEDULE,
      now: () => LAUNCH_MS + 60 * ONE_DAY,
    });

    expect(
      listAuditEntries(db, { event: D30_500_USDC_SCHEDULE.eventName }),
    ).toHaveLength(1);
    expect(
      listAuditEntries(db, { event: D60_REMOVE_CAP_SCHEDULE.eventName }),
    ).toHaveLength(1);
  });
});

describe("startCapUpgradeCron", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    seedMerchant(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("ticks on demand and applies the upgrade exactly once", async () => {
    const { broadcaster, calls } = recordingBroadcaster("sig_cron");
    const handle = startCapUpgradeCron({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster,
      intervalMs: 60_000,
      logger: makeLogger(),
    });
    try {
      // Override Date.now by feeding the schedule via a forced-now tick.
      // The cron's internal interval won't fire in the test window; we
      // drive it deterministically via handle.tick().
      const realNow = Date.now;
      Date.now = (): number => LAUNCH_MS + 30 * ONE_DAY;
      try {
        const first = await handle.tick();
        expect(first.kind).toBe("applied");
        const second = await handle.tick();
        expect(second.kind).toBe("already_applied");
      } finally {
        Date.now = realNow;
      }
    } finally {
      await handle.close();
    }
    expect(calls).toEqual([500_000_000n]);
  });

  it("invokes onResult with every tick outcome", async () => {
    const results: string[] = [];
    const handle = startCapUpgradeCron({
      db,
      betaConfig: makeBetaConfig(LAUNCH_AT),
      broadcaster: recordingBroadcaster().broadcaster,
      intervalMs: 60_000,
      onResult: (o) => {
        results.push(o.kind);
      },
    });
    try {
      const realNow = Date.now;
      Date.now = (): number => LAUNCH_MS + ONE_DAY; // D+1: not_due
      try {
        await handle.tick();
      } finally {
        Date.now = realNow;
      }
    } finally {
      await handle.close();
    }
    expect(results).toEqual(["not_due"]);
  });
});
