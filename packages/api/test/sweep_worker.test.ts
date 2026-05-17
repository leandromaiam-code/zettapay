// Z51 — sweep worker orchestration. Pure tests against the in-memory mocks;
// the real BTC / EVM adapters live in /api/_lib and are exercised separately
// by the Vercel cron entrypoint. The matrix here covers: happy path, BTC
// skip when treasury unconfigured, EVM treasury skip, idempotent re-broadcast
// short-circuit, consecutive-failure WhatsApp alert, audit journal coverage.

import { describe, expect, it, vi } from "vitest";
import {
  readSweepConfigFromEnv,
  sweepInvoice,
  sweepOnce,
  type BtcSweeper,
  type EvmSweeper,
  type SweepableInvoice,
  type SweepAlerter,
  type SweepAuditLogger,
  type SweepConfig,
  type SweepDeps,
  type SweepInvoiceStore,
  type SweeperOutcome,
} from "../src/services/sweep_worker.js";

const baseConfig: SweepConfig = {
  intervalMs: 60_000,
  batchLimit: 50,
  consecutiveFailureAlertThreshold: 3,
  treasury: { btc: "bc1qtreasury", evm: "0xtreasury" },
};

function btcInvoice(overrides: Partial<SweepableInvoice> = {}): SweepableInvoice {
  return {
    id: "inv-btc",
    merchantId: "merchant-1",
    chain: "btc",
    derivationPath: "m/84'/0'/0'/0/0",
    receiveAddress: "bc1qfrom",
    amountNative: "0.001",
    sweepAttempts: 0,
    sweepTxHash: null,
    ...overrides,
  };
}

function evmInvoice(overrides: Partial<SweepableInvoice> = {}): SweepableInvoice {
  return {
    id: "inv-evm",
    merchantId: "merchant-2",
    chain: "base",
    derivationPath: "m/44'/60'/0'/0/0",
    receiveAddress: "0xfrom",
    amountNative: "10",
    sweepAttempts: 0,
    sweepTxHash: null,
    ...overrides,
  };
}

function makeDeps(overrides: {
  invoices?: SweepableInvoice[];
  btcOutcome?: SweeperOutcome;
  evmOutcome?: SweeperOutcome;
  isOnchainConfirmed?: boolean;
  config?: Partial<SweepConfig>;
} = {}): SweepDeps & {
  audit: { entries: Array<{ invoiceId: string; outcome: SweeperOutcome }> };
  store: SweepInvoiceStore & { swept: Map<string, string>; attempts: Map<string, number> };
  alerter: SweepAlerter & { calls: Array<{ chain: string; consecutive: number; lastReason: string }> };
} {
  const invoices = overrides.invoices ?? [];
  const swept = new Map<string, string>();
  const attempts = new Map<string, number>();
  const auditEntries: Array<{ invoiceId: string; outcome: SweeperOutcome }> = [];
  const alerterCalls: Array<{ chain: string; consecutive: number; lastReason: string }> = [];

  const store: SweepInvoiceStore & { swept: Map<string, string>; attempts: Map<string, number> } = {
    swept,
    attempts,
    async listConfirmedUnswept() {
      return invoices;
    },
    async markSweepAttempt(invoiceId) {
      attempts.set(invoiceId, (attempts.get(invoiceId) ?? 0) + 1);
    },
    async markSwept(invoiceId, txHash) {
      swept.set(invoiceId, txHash);
    },
    async isOnchainConfirmed() {
      return overrides.isOnchainConfirmed ?? false;
    },
  };
  const btc: BtcSweeper = {
    consolidate: vi.fn(async () => overrides.btcOutcome ?? { kind: "swept", txHash: "btc-tx" }),
  };
  const evm: EvmSweeper = {
    sweepUsdc: vi.fn(async () => overrides.evmOutcome ?? { kind: "swept", txHash: "evm-tx" }),
  };
  const audit: SweepAuditLogger & { entries: typeof auditEntries } = {
    entries: auditEntries,
    async record(entry) {
      auditEntries.push({ invoiceId: entry.invoiceId, outcome: entry.outcome });
    },
  };
  const alerter: SweepAlerter & { calls: typeof alerterCalls } = {
    calls: alerterCalls,
    async notifyConsecutiveFailures(payload) {
      alerterCalls.push(payload);
    },
  };
  return {
    store,
    btc,
    evm,
    audit,
    alerter,
    config: { ...baseConfig, ...(overrides.config ?? {}) },
  };
}

describe("readSweepConfigFromEnv", () => {
  it("falls back to safe defaults when env is empty", () => {
    const cfg = readSweepConfigFromEnv({});
    expect(cfg.intervalMs).toBe(60 * 60 * 1000);
    expect(cfg.batchLimit).toBe(50);
    expect(cfg.consecutiveFailureAlertThreshold).toBe(3);
    expect(cfg.treasury).toEqual({ btc: null, evm: null });
  });

  it("honors SWEEP_INTERVAL_MINUTES and treasury addresses", () => {
    const cfg = readSweepConfigFromEnv({
      SWEEP_INTERVAL_MINUTES: "15",
      BTC_TREASURY_ADDRESS: "bc1q...",
      EVM_TREASURY_ADDRESS: "0xabc",
    });
    expect(cfg.intervalMs).toBe(15 * 60 * 1000);
    expect(cfg.treasury.btc).toBe("bc1q...");
    expect(cfg.treasury.evm).toBe("0xabc");
  });

  it("ignores non-positive interval values", () => {
    expect(readSweepConfigFromEnv({ SWEEP_INTERVAL_MINUTES: "0" }).intervalMs).toBe(60 * 60 * 1000);
    expect(readSweepConfigFromEnv({ SWEEP_INTERVAL_MINUTES: "-5" }).intervalMs).toBe(60 * 60 * 1000);
    expect(readSweepConfigFromEnv({ SWEEP_INTERVAL_MINUTES: "abc" }).intervalMs).toBe(60 * 60 * 1000);
  });
});

describe("sweepInvoice", () => {
  it("delegates BTC invoices to the BTC sweeper with the configured treasury", async () => {
    const deps = makeDeps();
    const outcome = await sweepInvoice(btcInvoice(), deps);
    expect(outcome).toEqual({ kind: "swept", txHash: "btc-tx" });
    expect(deps.btc.consolidate).toHaveBeenCalledWith({
      derivationPath: "m/84'/0'/0'/0/0",
      fromAddress: "bc1qfrom",
      treasuryAddress: "bc1qtreasury",
    });
  });

  it("delegates EVM invoices to the EVM sweeper", async () => {
    const deps = makeDeps();
    const outcome = await sweepInvoice(evmInvoice(), deps);
    expect(outcome).toEqual({ kind: "swept", txHash: "evm-tx" });
    expect(deps.evm.sweepUsdc).toHaveBeenCalledWith({
      chain: "base",
      derivationPath: "m/44'/60'/0'/0/0",
      fromAddress: "0xfrom",
      treasuryAddress: "0xtreasury",
    });
  });

  it("skips BTC sweeps when no treasury is configured", async () => {
    const deps = makeDeps({ config: { treasury: { btc: null, evm: "0x" } } });
    const outcome = await sweepInvoice(btcInvoice(), deps);
    expect(outcome.kind).toBe("skipped");
    expect(deps.btc.consolidate).not.toHaveBeenCalled();
  });

  it("skips EVM sweeps when no treasury is configured", async () => {
    const deps = makeDeps({ config: { treasury: { btc: "bc1q", evm: null } } });
    const outcome = await sweepInvoice(evmInvoice(), deps);
    expect(outcome.kind).toBe("skipped");
    expect(deps.evm.sweepUsdc).not.toHaveBeenCalled();
  });

  it("short-circuits when a prior sweep tx already confirmed on-chain", async () => {
    const deps = makeDeps({ isOnchainConfirmed: true });
    const outcome = await sweepInvoice(btcInvoice({ sweepTxHash: "prior-tx" }), deps);
    expect(outcome).toEqual({ kind: "swept", txHash: "prior-tx" });
    expect(deps.btc.consolidate).not.toHaveBeenCalled();
  });

  it("re-broadcasts when the prior sweep tx isn't confirmed yet", async () => {
    const deps = makeDeps({ isOnchainConfirmed: false });
    const outcome = await sweepInvoice(btcInvoice({ sweepTxHash: "prior-tx" }), deps);
    expect(outcome).toEqual({ kind: "swept", txHash: "btc-tx" });
    expect(deps.btc.consolidate).toHaveBeenCalledTimes(1);
  });
});

describe("sweepOnce", () => {
  it("records audit entries and marks rows swept for successful invoices", async () => {
    const invoices = [btcInvoice(), evmInvoice()];
    const deps = makeDeps({ invoices });
    const result = await sweepOnce(deps);
    expect(result.attempted).toBe(2);
    expect(result.swept).toBe(2);
    expect(result.failed).toBe(0);
    expect(deps.store.swept.get("inv-btc")).toBe("btc-tx");
    expect(deps.store.swept.get("inv-evm")).toBe("evm-tx");
    expect(deps.audit.entries.map((e) => e.outcome.kind)).toEqual(["swept", "swept"]);
  });

  it("increments attempt counter for every invoice considered", async () => {
    const deps = makeDeps({ invoices: [btcInvoice()] });
    await sweepOnce(deps);
    expect(deps.store.attempts.get("inv-btc")).toBe(1);
  });

  it("emits a WhatsApp alert when consecutive BTC failures hit the threshold", async () => {
    const invoices = [
      btcInvoice({ id: "inv-1" }),
      btcInvoice({ id: "inv-2" }),
      btcInvoice({ id: "inv-3" }),
    ];
    const deps = makeDeps({
      invoices,
      btcOutcome: { kind: "failed", reason: "rpc down" },
    });
    const result = await sweepOnce(deps);
    expect(result.failed).toBe(3);
    expect(deps.alerter.calls).toHaveLength(1);
    expect(deps.alerter.calls[0]).toMatchObject({ chain: "btc", consecutive: 3 });
  });

  it("does not page when failure count is below threshold", async () => {
    const deps = makeDeps({
      invoices: [btcInvoice(), btcInvoice({ id: "inv-2" })],
      btcOutcome: { kind: "failed", reason: "rpc down" },
    });
    await sweepOnce(deps);
    expect(deps.alerter.calls).toHaveLength(0);
  });

  it("converts sweeper exceptions into structured failures", async () => {
    const deps = makeDeps({
      invoices: [btcInvoice()],
      btcOutcome: { kind: "swept", txHash: "x" },
    });
    deps.btc.consolidate = vi.fn(async () => {
      throw new Error("boom");
    });
    const result = await sweepOnce(deps);
    expect(result.failed).toBe(1);
    expect(result.outcomes[0]?.outcome).toEqual({ kind: "failed", reason: "boom" });
    expect(deps.audit.entries[0]?.outcome).toEqual({ kind: "failed", reason: "boom" });
  });

  it("resets the per-family failure counter after a successful sweep", async () => {
    const invoices = [
      btcInvoice({ id: "fail-1" }),
      btcInvoice({ id: "fail-2" }),
      btcInvoice({ id: "ok-1" }),
      btcInvoice({ id: "fail-3" }),
      btcInvoice({ id: "fail-4" }),
    ];
    // Use a per-call mock so we can interleave outcomes.
    const outcomes: SweeperOutcome[] = [
      { kind: "failed", reason: "rpc" },
      { kind: "failed", reason: "rpc" },
      { kind: "swept", txHash: "tx-ok" },
      { kind: "failed", reason: "rpc" },
      { kind: "failed", reason: "rpc" },
    ];
    let i = 0;
    const deps = makeDeps({ invoices });
    deps.btc.consolidate = vi.fn(async () => outcomes[i++]!);
    await sweepOnce(deps);
    expect(deps.alerter.calls).toHaveLength(0);
  });
});
