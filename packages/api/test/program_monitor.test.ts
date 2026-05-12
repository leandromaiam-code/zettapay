import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { appendAudit } from "../src/db/audit_journal.js";
import {
  createHttpWhatsAppNotifier,
  evaluateProgramHealth,
  readProgramMonitorConfigFromEnv,
  startProgramMonitor,
  type ProgramHealthAlert,
  type WhatsAppNotifier,
} from "../src/services/program_monitor.js";

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

function isoMinusMinutes(now: number, minutes: number): string {
  return new Date(now - minutes * 60_000).toISOString();
}

interface SeedPaymentRow {
  id: string;
  status: "pending" | "processing" | "completed" | "failed" | "refunded";
  createdAt: string;
}

function seedMerchant(db: Db, id = "m_test"): void {
  db.prepare(
    `INSERT INTO merchants (id, name, wallet_address, email, api_key)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, "test", "wallet_" + id, id + "@example.com", "k_" + id);
}

function seedPayment(db: Db, merchantId: string, row: SeedPaymentRow): void {
  db.prepare(
    `INSERT INTO payments (id, merchant_id, amount_usdc, payer_wallet, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, merchantId, 10, "payer_" + row.id, row.status, row.createdAt);
}

describe("evaluateProgramHealth", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    seedMerchant(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("returns zero metrics and no alerts on a fresh DB", () => {
    const snap = evaluateProgramHealth(db, { now: () => 1_700_000_000_000 });
    expect(snap.alerts).toEqual([]);
    expect(snap.metrics.totalSettled).toBe(0);
    expect(snap.metrics.failedPayments).toBe(0);
    expect(snap.metrics.errorRatePct).toBe(0);
    expect(snap.metrics.stuckCount).toBe(0);
    expect(snap.metrics.sweepFailures).toBe(0);
    expect(snap.metrics.suspiciousAccountCloses).toBe(0);
  });

  it("does not raise error_rate below errorRateMinSamples", () => {
    const now = 1_700_000_000_000;
    // 2 failed, 0 completed — 100% error rate but only 2 samples.
    seedPayment(db, "m_test", {
      id: "p1",
      status: "failed",
      createdAt: isoMinusMinutes(now, 5),
    });
    seedPayment(db, "m_test", {
      id: "p2",
      status: "failed",
      createdAt: isoMinusMinutes(now, 10),
    });
    const snap = evaluateProgramHealth(db, {
      now: () => now,
      thresholds: { errorRateMinSamples: 10 },
    });
    expect(snap.metrics.errorRatePct).toBe(100);
    expect(snap.alerts.find((a) => a.kind === "error_rate")).toBeUndefined();
  });

  it("raises error_rate when failed/total > threshold", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 95; i++) {
      seedPayment(db, "m_test", {
        id: "p_ok_" + i,
        status: "completed",
        createdAt: isoMinusMinutes(now, 30),
      });
    }
    for (let i = 0; i < 5; i++) {
      seedPayment(db, "m_test", {
        id: "p_fail_" + i,
        status: "failed",
        createdAt: isoMinusMinutes(now, 30),
      });
    }
    const snap = evaluateProgramHealth(db, {
      now: () => now,
      thresholds: { errorRatePct: 1, errorRateMinSamples: 10 },
    });
    expect(snap.metrics.totalSettled).toBe(100);
    expect(snap.metrics.failedPayments).toBe(5);
    expect(snap.metrics.errorRatePct).toBeCloseTo(5);
    const alert = snap.alerts.find((a) => a.kind === "error_rate");
    expect(alert?.severity).toBe("critical");
  });

  it("ignores rows older than the rolling window", () => {
    const now = 1_700_000_000_000;
    // 90 minutes ago — outside the default 60-minute window.
    for (let i = 0; i < 100; i++) {
      seedPayment(db, "m_test", {
        id: "old_" + i,
        status: "failed",
        createdAt: isoMinusMinutes(now, 90),
      });
    }
    const snap = evaluateProgramHealth(db, { now: () => now });
    expect(snap.metrics.totalSettled).toBe(0);
    expect(snap.metrics.errorRatePct).toBe(0);
    expect(snap.alerts.find((a) => a.kind === "error_rate")).toBeUndefined();
  });

  it("raises invoice_stuck for pending/processing rows past the threshold", () => {
    const now = 1_700_000_000_000;
    // 70 minutes old, still processing — past the 60-minute default.
    seedPayment(db, "m_test", {
      id: "stuck_1",
      status: "processing",
      createdAt: isoMinusMinutes(now, 70),
    });
    seedPayment(db, "m_test", {
      id: "stuck_2",
      status: "pending",
      createdAt: isoMinusMinutes(now, 90),
    });
    // 10 minutes old, still inside the threshold — should not count.
    seedPayment(db, "m_test", {
      id: "fresh",
      status: "processing",
      createdAt: isoMinusMinutes(now, 10),
    });
    const snap = evaluateProgramHealth(db, { now: () => now });
    expect(snap.metrics.stuckCount).toBe(2);
    expect(snap.metrics.stuckOldestAgeMs).not.toBeNull();
    expect(snap.metrics.stuckOldestAgeMs).toBeGreaterThanOrEqual(90 * 60_000);
    const alert = snap.alerts.find((a) => a.kind === "invoice_stuck");
    expect(alert).toBeDefined();
    expect(alert?.severity).toBe("warning");
  });

  it("raises sweep_failed when audit_journal carries sweep failure events", () => {
    const now = 1_700_000_000_000;
    appendAudit(db, {
      actor: "cron:sweep",
      event: "sweep.failed",
      reason: "tx simulation failed",
    });
    const snap = evaluateProgramHealth(db, { now: () => now });
    expect(snap.metrics.sweepFailures).toBeGreaterThanOrEqual(1);
    expect(
      snap.alerts.find((a) => a.kind === "sweep_failed"),
    ).toBeDefined();
  });

  it("raises account_close on account_close_suspect events", () => {
    appendAudit(db, {
      actor: "indexer",
      event: "indexer.account_close_suspect",
      reason: "Merchant PDA closed unexpectedly",
    });
    const snap = evaluateProgramHealth(db);
    expect(snap.metrics.suspiciousAccountCloses).toBeGreaterThanOrEqual(1);
    expect(
      snap.alerts.find((a) => a.kind === "account_close"),
    ).toBeDefined();
  });

  it("ignores refunded payments in the error-rate computation", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 30; i++) {
      seedPayment(db, "m_test", {
        id: "ref_" + i,
        status: "refunded",
        createdAt: isoMinusMinutes(now, 5),
      });
    }
    const snap = evaluateProgramHealth(db, {
      now: () => now,
      thresholds: { errorRateMinSamples: 10 },
    });
    expect(snap.metrics.totalSettled).toBe(0);
    expect(snap.alerts).toEqual([]);
  });
});

describe("startProgramMonitor — dedup + recovery", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    seedMerchant(db);
  });

  afterEach(() => {
    closeDatabase();
  });

  it("notifies once per alert kind on first breach, not on every tick", async () => {
    const now = 1_700_000_000_000;
    // Seed a stuck payment so invoice_stuck fires.
    seedPayment(db, "m_test", {
      id: "stuck",
      status: "processing",
      createdAt: isoMinusMinutes(now, 90),
    });
    const send = vi.fn(async () => {});
    const notifier: WhatsAppNotifier = { send };
    const handle = startProgramMonitor({
      db,
      now: () => now,
      notifier,
      logger: makeLogger(),
      intervalMs: 60_000,
    });
    try {
      await handle.tick();
      await handle.tick();
      await handle.tick();
    } finally {
      await handle.close();
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(handle.state().raised.invoice_stuck).toBe(true);
  });

  it("clears the raised flag once the signal disappears", async () => {
    const now = 1_700_000_000_000;
    const stuckRow: SeedPaymentRow = {
      id: "stuck",
      status: "processing",
      createdAt: isoMinusMinutes(now, 90),
    };
    seedPayment(db, "m_test", stuckRow);
    const send = vi.fn(async () => {});
    const handle = startProgramMonitor({
      db,
      now: () => now,
      notifier: { send },
      logger: makeLogger(),
      intervalMs: 60_000,
    });
    try {
      await handle.tick();
      expect(handle.state().raised.invoice_stuck).toBe(true);
      db.prepare("DELETE FROM payments WHERE id = ?").run("stuck");
      await handle.tick();
      expect(handle.state().raised.invoice_stuck).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("re-fires once recovery flips back to breach", async () => {
    // audit_journal is append-only (triggers reject UPDATE/DELETE), so we
    // drive this scenario through `payments`, which the monitor reads for the
    // invoice_stuck signal — insert→raise, delete→clear, insert→re-raise.
    const now = 1_700_000_000_000;
    const send = vi.fn(async () => {});
    const handle = startProgramMonitor({
      db,
      now: () => now,
      notifier: { send },
      logger: makeLogger(),
      intervalMs: 60_000,
    });
    try {
      seedPayment(db, "m_test", {
        id: "first",
        status: "processing",
        createdAt: isoMinusMinutes(now, 90),
      });
      await handle.tick();
      expect(send).toHaveBeenCalledTimes(1);
      // Clear the stuck row so the alert kind recovers.
      db.prepare("DELETE FROM payments WHERE id = ?").run("first");
      await handle.tick();
      expect(handle.state().raised.invoice_stuck).toBe(false);
      // A fresh stuck payment should re-page.
      seedPayment(db, "m_test", {
        id: "second",
        status: "processing",
        createdAt: isoMinusMinutes(now, 90),
      });
      await handle.tick();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      await handle.close();
    }
  });

  it("swallows notifier failures so the loop keeps running", async () => {
    const now = 1_700_000_000_000;
    seedPayment(db, "m_test", {
      id: "stuck",
      status: "pending",
      createdAt: isoMinusMinutes(now, 90),
    });
    const send = vi.fn(async () => {
      throw new Error("provider 503");
    });
    const log = makeLogger();
    const handle = startProgramMonitor({
      db,
      now: () => now,
      notifier: { send },
      logger: log,
      intervalMs: 60_000,
    });
    try {
      const snap = await handle.tick();
      expect(snap.alerts.length).toBeGreaterThan(0);
      expect(log.error).toHaveBeenCalledWith(
        "program_monitor.notifier_failed",
        expect.objectContaining({ kind: "invoice_stuck" }),
      );
    } finally {
      await handle.close();
    }
  });

  it("runs without a notifier — logs only when one isn't configured", async () => {
    const now = 1_700_000_000_000;
    appendAudit(db, {
      actor: "cron:sweep",
      event: "sweep.failed",
    });
    const log = makeLogger();
    const handle = startProgramMonitor({
      db,
      now: () => now,
      logger: log,
      intervalMs: 60_000,
    });
    try {
      const snap = await handle.tick();
      expect(snap.alerts).toHaveLength(1);
      expect(log.error).toHaveBeenCalledWith(
        "program_monitor.alert_raised",
        expect.objectContaining({ kind: "sweep_failed" }),
      );
    } finally {
      await handle.close();
    }
  });
});

describe("createHttpWhatsAppNotifier", () => {
  it("POSTs a WhatsApp Cloud API text payload to the configured URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const notifier = createHttpWhatsAppNotifier({
      url: "https://hook.example/whatsapp",
      operatorNumber: "+5511999999999",
      token: "abc",
      fromNumber: "+15555550100",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const alert: ProgramHealthAlert = {
      kind: "sweep_failed",
      severity: "critical",
      message: "boom",
      detail: {},
    };
    await notifier.send("hello", {
      alert,
      snapshot: {
        generatedAt: "2026-05-12T00:00:00.000Z",
        windowStartedAt: "2026-05-11T23:00:00.000Z",
        metrics: {
          totalSettled: 0,
          failedPayments: 0,
          errorRatePct: 0,
          stuckCount: 0,
          stuckOldestAgeMs: null,
          sweepFailures: 1,
          suspiciousAccountCloses: 0,
        },
        alerts: [alert],
      },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [, init] = fetchImpl.mock.calls[0]!;
    const initObj = init as RequestInit;
    expect((initObj.headers as Record<string, string>)["authorization"]).toBe(
      "Bearer abc",
    );
    const body = JSON.parse(initObj.body as string) as Record<string, unknown>;
    expect(body["messaging_product"]).toBe("whatsapp");
    expect(body["to"]).toBe("+5511999999999");
    expect(body["from"]).toBe("+15555550100");
    const text = body["text"] as { body: string };
    expect(text.body).toBe("hello");
  });

  it("throws when the webhook returns a non-2xx", async () => {
    const fetchImpl = vi.fn(async () => new Response("err", { status: 502 }));
    const notifier = createHttpWhatsAppNotifier({
      url: "https://hook.example/whatsapp",
      operatorNumber: "+5511999999999",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const snapshot = {
      generatedAt: "x",
      windowStartedAt: "x",
      metrics: {
        totalSettled: 0,
        failedPayments: 0,
        errorRatePct: 0,
        stuckCount: 0,
        stuckOldestAgeMs: null,
        sweepFailures: 0,
        suspiciousAccountCloses: 0,
      },
      alerts: [],
    };
    await expect(
      notifier.send("hi", {
        alert: {
          kind: "error_rate",
          severity: "critical",
          message: "x",
          detail: {},
        },
        snapshot,
      }),
    ).rejects.toThrow(/502/);
  });
});

describe("readProgramMonitorConfigFromEnv", () => {
  it("is enabled when WhatsApp credentials are present", () => {
    const cfg = readProgramMonitorConfigFromEnv({
      WHATSAPP_WEBHOOK_URL: "https://hook.example",
      WHATSAPP_OPERATOR_NUMBER: "+5511999999999",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.notifier?.url).toBe("https://hook.example");
    expect(cfg.notifier?.operatorNumber).toBe("+5511999999999");
  });

  it("is disabled when credentials are missing and the flag isn't set", () => {
    const cfg = readProgramMonitorConfigFromEnv({} as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
    expect(cfg.notifier).toBeNull();
  });

  it("can be force-enabled via PROGRAM_MONITOR_ENABLED=1 even without webhook", () => {
    const cfg = readProgramMonitorConfigFromEnv({
      PROGRAM_MONITOR_ENABLED: "1",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(true);
    expect(cfg.notifier).toBeNull();
  });

  it("can be force-disabled via PROGRAM_MONITOR_ENABLED=false even with webhook", () => {
    const cfg = readProgramMonitorConfigFromEnv({
      PROGRAM_MONITOR_ENABLED: "false",
      WHATSAPP_WEBHOOK_URL: "https://hook.example",
      WHATSAPP_OPERATOR_NUMBER: "+5511999999999",
    } as NodeJS.ProcessEnv);
    expect(cfg.enabled).toBe(false);
  });

  it("parses threshold overrides", () => {
    const cfg = readProgramMonitorConfigFromEnv({
      PROGRAM_MONITOR_ERROR_RATE_PCT: "2.5",
      PROGRAM_MONITOR_ERROR_RATE_MIN_SAMPLES: "50",
      PROGRAM_MONITOR_STUCK_INVOICE_MS: "1800000",
      PROGRAM_MONITOR_WINDOW_MS: "7200000",
      PROGRAM_MONITOR_INTERVAL_MS: "120000",
    } as NodeJS.ProcessEnv);
    expect(cfg.thresholds.errorRatePct).toBe(2.5);
    expect(cfg.thresholds.errorRateMinSamples).toBe(50);
    expect(cfg.thresholds.stuckInvoiceMs).toBe(1_800_000);
    expect(cfg.thresholds.windowMs).toBe(7_200_000);
    expect(cfg.intervalMs).toBe(120_000);
  });

  it("falls back to defaults on bogus numeric input", () => {
    const cfg = readProgramMonitorConfigFromEnv({
      PROGRAM_MONITOR_ERROR_RATE_PCT: "not-a-number",
      PROGRAM_MONITOR_STUCK_INVOICE_MS: "-100",
    } as NodeJS.ProcessEnv);
    expect(cfg.thresholds.errorRatePct).toBe(1);
    expect(cfg.thresholds.stuckInvoiceMs).toBe(60 * 60 * 1000);
  });
});
