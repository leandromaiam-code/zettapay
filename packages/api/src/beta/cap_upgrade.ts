import type { Database as Db } from "better-sqlite3";
import { appendAudit, listAuditEntries } from "../db/audit_journal.js";
import { logger as defaultLogger, type Logger } from "../lib/logger.js";
import { Counter, registry } from "../lib/metrics.js";
import {
  evaluateProgramHealth,
  type ProgramHealthAlert,
  type ProgramHealthSnapshot,
  type ProgramMonitorThresholds,
} from "../services/program_monitor.js";
import { betaEndsAt, type BetaLaunchConfig } from "./config.js";

/**
 * Z30.4 — Beta cap upgrade orchestrator.
 *
 * During the beta mainnet window the per-merchant cap starts low and is
 * raised gradually as the protocol clocks bug-free hours. This module is the
 * Fabric-driven automation that, at D+30 after `BETA_LAUNCH_AT`, calls
 * `set_max_invoice_amount(500_000_000)` (500 USDC at 6 decimals) — but only
 * when zero critical alerts are firing on the 24/7 program health monitor
 * (Z30.3).
 *
 * Idempotency is anchored in `audit_journal`: applying the upgrade writes a
 * row with `event = schedule.eventName`. Subsequent ticks see the row and
 * short-circuit. The audit row is the canonical record of which caps have
 * been applied — so this module composes with future upgrade missions
 * (Z30.5 etc.) by adding new schedule entries with distinct event names.
 *
 * The Solana broadcast itself is plugged in via the `CapBroadcaster`
 * interface — keep this module wire-agnostic so it can be unit-tested with a
 * fake and, when the on-chain `set_max_invoice_amount` instruction lands,
 * switched to a real Solana RPC broadcaster without touching the orchestrator.
 */

const USDC_DECIMALS = 6;
const USDC_BASE_UNITS_PER_USD = 10n ** BigInt(USDC_DECIMALS);

export interface CapUpgradeSchedule {
  /** Days after `BETA_LAUNCH_AT` when the upgrade is eligible to fire. */
  triggerAfterDays: number;
  /** Target max invoice amount, in USDC base units (6 decimals). */
  maxInvoiceBaseUnits: bigint;
  /**
   * Canonical audit_journal event name. Doubles as the idempotency key —
   * once a row with this event exists, the orchestrator treats the upgrade
   * as applied and refuses to re-fire.
   */
  eventName: string;
}

/** D+30 → $500 cap, per Sprint Z30 roadmap (beta mainnet limited, 60 days). */
export const D30_500_USDC_SCHEDULE: CapUpgradeSchedule = {
  triggerAfterDays: 30,
  maxInvoiceBaseUnits: 500n * USDC_BASE_UNITS_PER_USD,
  eventName: "cap_upgrade.set_max_invoice_amount.d30",
};

/**
 * Z30.5 — D+60 cap REMOVAL. After 60 days of bug-free operation, the
 * orchestrator broadcasts `set_max_invoice_amount(0)`, which the on-chain
 * program interprets as "no per-invoice ceiling" (Z30.1 semantics). The
 * cap is gone and ZettaPay accepts arbitrary-sized invoices.
 */
export const D60_REMOVE_CAP_SCHEDULE: CapUpgradeSchedule = {
  triggerAfterDays: 60,
  maxInvoiceBaseUnits: 0n,
  eventName: "cap_upgrade.set_max_invoice_amount.d60_remove",
};

/** True when the schedule's outcome is "no cap" rather than a literal $0 ceiling. */
export function isCapRemovalSchedule(schedule: CapUpgradeSchedule): boolean {
  return schedule.maxInvoiceBaseUnits === 0n;
}

export type CapBroadcastResult =
  | { kind: "ok"; signature: string }
  | { kind: "skipped"; reason: string };

export interface CapBroadcaster {
  /**
   * Submit a `set_max_invoice_amount(amountBaseUnits)` transaction. The
   * orchestrator awaits this call; failures bubble up as `broadcast_failed`
   * outcomes and DO NOT write the audit row, so the next tick retries.
   */
  setMaxInvoiceAmount(amountBaseUnits: bigint): Promise<CapBroadcastResult>;
}

/**
 * Stub broadcaster — records the intent locally without submitting to chain.
 *
 * Used in environments where the on-chain `set_max_invoice_amount`
 * instruction is not yet deployed, or in tests. Returns a deterministic
 * pseudo-signature so audit rows still carry a populated `signature` field
 * downstream.
 */
export function noopCapBroadcaster(): CapBroadcaster {
  return {
    async setMaxInvoiceAmount(amountBaseUnits) {
      return {
        kind: "skipped",
        reason: `noop_broadcaster:${amountBaseUnits.toString()}`,
      };
    },
  };
}

export type CapUpgradeOutcome =
  | { kind: "not_due"; firesAt: string }
  | { kind: "no_launch_date" }
  | { kind: "already_applied"; appliedAt: string; amountBaseUnits: bigint }
  | {
      kind: "blocked_health";
      alerts: ReadonlyArray<ProgramHealthAlert>;
      snapshot: ProgramHealthSnapshot;
    }
  | { kind: "broadcast_failed"; error: string }
  | {
      kind: "applied";
      signature: string | null;
      broadcastSkipped: boolean;
      amountBaseUnits: bigint;
      auditId: number;
    };

export interface RunCapUpgradeInput {
  db: Db;
  betaConfig: BetaLaunchConfig;
  broadcaster: CapBroadcaster;
  schedule?: CapUpgradeSchedule;
  /** Test seam. Defaults to `Date.now`. */
  now?: () => number;
  /** Forwarded to `evaluateProgramHealth` so callers can tune the gate. */
  thresholds?: Partial<ProgramMonitorThresholds>;
  logger?: Logger;
}

/** ISO timestamp when the upgrade becomes eligible: `launchAt + triggerAfterDays`. */
export function capUpgradeFiresAt(
  launchAtIso: string,
  schedule: CapUpgradeSchedule,
): string {
  const startMs = Date.parse(launchAtIso);
  return new Date(
    startMs + schedule.triggerAfterDays * 24 * 60 * 60_000,
  ).toISOString();
}

export function isCapUpgradeDue(
  launchAtIso: string,
  schedule: CapUpgradeSchedule,
  now: number,
): boolean {
  return now >= Date.parse(capUpgradeFiresAt(launchAtIso, schedule));
}

export interface AppliedCapRecord {
  appliedAt: string;
  amountBaseUnits: bigint;
  signature: string | null;
  broadcastSkipped: boolean;
}

/**
 * Look up the most recent `audit_journal` row matching `eventName`. Returns
 * `null` when the upgrade has never been applied. The audit row is the
 * single source of truth for idempotency — there is no parallel `cap_state`
 * table, so we cannot apply the upgrade twice as long as the audit table
 * stays append-only (enforced by triggers in `db/index.ts`).
 */
export function findAppliedCap(
  db: Db,
  schedule: CapUpgradeSchedule,
): AppliedCapRecord | null {
  const rows = listAuditEntries(db, {
    event: schedule.eventName,
    limit: 1,
  });
  if (rows.length === 0) return null;
  const row = rows[0]!;
  const payload =
    row.payload && typeof row.payload === "object"
      ? (row.payload as Record<string, unknown>)
      : {};
  const amountRaw = payload["amountBaseUnits"];
  const amount =
    typeof amountRaw === "string" || typeof amountRaw === "number"
      ? BigInt(amountRaw)
      : schedule.maxInvoiceBaseUnits;
  const signatureRaw = payload["signature"];
  const signature =
    typeof signatureRaw === "string" && signatureRaw.length > 0
      ? signatureRaw
      : null;
  const broadcastSkipped = payload["broadcastSkipped"] === true;
  return {
    appliedAt: row.createdAt,
    amountBaseUnits: amount,
    signature,
    broadcastSkipped,
  };
}

const capUpgradeOutcomesTotal = registry.register(
  new Counter(
    "zettapay_cap_upgrade_outcomes_total",
    "Cap-upgrade orchestrator ticks, labeled by terminal outcome.",
    ["event", "outcome"],
  ),
);

/**
 * Run one evaluation of the cap upgrade orchestrator. Pure-async — never
 * throws. Six terminal outcomes:
 *
 *   not_due          — `now < launchAt + triggerAfterDays`. Cron keeps polling.
 *   no_launch_date   — `BETA_LAUNCH_AT` unset. Cron logs and skips.
 *   already_applied  — audit row exists; tick is a no-op.
 *   blocked_health   — program monitor returned ≥1 alert; refuse to fire.
 *                      The Z30 goal is "cap upgrade only with zero critical
 *                      bugs," so this gate is fail-closed.
 *   broadcast_failed — broadcaster threw or rejected. No audit row written
 *                      so the next tick retries.
 *   applied          — broadcaster succeeded (or noop'd) AND audit row was
 *                      appended. Future ticks see `already_applied`.
 */
export async function runCapUpgrade(
  input: RunCapUpgradeInput,
): Promise<CapUpgradeOutcome> {
  const schedule = input.schedule ?? D30_500_USDC_SCHEDULE;
  const now = (input.now ?? Date.now)();
  const log = input.logger ?? defaultLogger;
  const eventLabel = schedule.eventName;

  const launchAt = input.betaConfig.launchAt;
  if (!launchAt) {
    capUpgradeOutcomesTotal.inc(
      { event: eventLabel, outcome: "no_launch_date" },
      1,
    );
    return { kind: "no_launch_date" };
  }

  if (!isCapUpgradeDue(launchAt, schedule, now)) {
    const firesAt = capUpgradeFiresAt(launchAt, schedule);
    capUpgradeOutcomesTotal.inc({ event: eventLabel, outcome: "not_due" }, 1);
    return { kind: "not_due", firesAt };
  }

  const existing = findAppliedCap(input.db, schedule);
  if (existing) {
    capUpgradeOutcomesTotal.inc(
      { event: eventLabel, outcome: "already_applied" },
      1,
    );
    return {
      kind: "already_applied",
      appliedAt: existing.appliedAt,
      amountBaseUnits: existing.amountBaseUnits,
    };
  }

  const snapshot = evaluateProgramHealth(input.db, {
    ...(input.thresholds ? { thresholds: input.thresholds } : {}),
    now: () => now,
  });
  if (snapshot.alerts.length > 0) {
    capUpgradeOutcomesTotal.inc(
      { event: eventLabel, outcome: "blocked_health" },
      1,
    );
    log.warn("cap_upgrade.blocked_by_health", {
      event: eventLabel,
      alertKinds: snapshot.alerts.map((a) => a.kind),
      firesAt: capUpgradeFiresAt(launchAt, schedule),
    });
    return {
      kind: "blocked_health",
      alerts: snapshot.alerts,
      snapshot,
    };
  }

  let broadcast: CapBroadcastResult;
  try {
    broadcast = await input.broadcaster.setMaxInvoiceAmount(
      schedule.maxInvoiceBaseUnits,
    );
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    capUpgradeOutcomesTotal.inc(
      { event: eventLabel, outcome: "broadcast_failed" },
      1,
    );
    log.error("cap_upgrade.broadcast_failed", {
      event: eventLabel,
      error,
    });
    return { kind: "broadcast_failed", error };
  }

  const signature = broadcast.kind === "ok" ? broadcast.signature : null;
  const broadcastSkipped = broadcast.kind === "skipped";
  const auditRow = appendAudit(input.db, {
    actor: "fabric.cap_upgrade",
    event: schedule.eventName,
    entityType: "program",
    entityId: schedule.maxInvoiceBaseUnits.toString(),
    reason:
      broadcast.kind === "ok"
        ? "broadcast_ok"
        : `broadcast_skipped:${broadcast.reason}`,
    payload: {
      amountBaseUnits: schedule.maxInvoiceBaseUnits.toString(),
      amountUsd: Number(
        schedule.maxInvoiceBaseUnits / USDC_BASE_UNITS_PER_USD,
      ),
      capRemoved: isCapRemovalSchedule(schedule),
      signature,
      broadcastSkipped,
      launchAt,
      firesAt: capUpgradeFiresAt(launchAt, schedule),
      betaWindowEndsAt: betaEndsAt(input.betaConfig),
      decimals: USDC_DECIMALS,
    },
  });

  capUpgradeOutcomesTotal.inc(
    { event: eventLabel, outcome: "applied" },
    1,
  );
  log.info("cap_upgrade.applied", {
    event: eventLabel,
    amountBaseUnits: schedule.maxInvoiceBaseUnits.toString(),
    signature,
    broadcastSkipped,
    auditId: auditRow.id,
  });

  return {
    kind: "applied",
    signature,
    broadcastSkipped,
    amountBaseUnits: schedule.maxInvoiceBaseUnits,
    auditId: auditRow.id,
  };
}
