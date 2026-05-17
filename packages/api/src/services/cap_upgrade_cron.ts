import type { Database as Db } from "better-sqlite3";
import type { BetaLaunchConfig } from "../beta/config.js";
import {
  D30_500_USDC_SCHEDULE,
  runCapUpgrade,
  type CapBroadcaster,
  type CapUpgradeOutcome,
  type CapUpgradeSchedule,
} from "../beta/cap_upgrade.js";
import type { Logger } from "../lib/logger.js";
import type { ProgramMonitorThresholds } from "../beta/cap_upgrade.js";

/**
 * Z30.4 — Cron wrapper around `runCapUpgrade`. Mirrors `subscription_cron`:
 * single setInterval, re-entrancy guarded, errors swallowed so the worker
 * never crashes mid-loop.
 *
 * Default cadence is 1h. The orchestrator is idempotent (audit-anchored)
 * and the D+30 boundary is only crossed once, so polling more often buys
 * nothing — but the loop still keeps running afterward as a no-op so future
 * cap-upgrade schedules can hook into the same cron handle.
 */

const DEFAULT_INTERVAL_MS = 60 * 60 * 1_000;
const MIN_INTERVAL_MS = 60_000;

export interface CapUpgradeCronOptions {
  db: Db;
  betaConfig: BetaLaunchConfig;
  broadcaster: CapBroadcaster;
  schedule?: CapUpgradeSchedule;
  intervalMs?: number;
  thresholds?: Partial<ProgramMonitorThresholds>;
  logger?: Logger;
  /** Test seam — invoked after each tick with the orchestrator outcome. */
  onResult?: (outcome: CapUpgradeOutcome) => void | Promise<void>;
}

export interface CapUpgradeCronHandle {
  close(): Promise<void>;
  /** Trigger a tick immediately. Returns the orchestrator outcome. */
  tick(): Promise<CapUpgradeOutcome>;
}

export function startCapUpgradeCron(
  options: CapUpgradeCronOptions,
): CapUpgradeCronHandle {
  const intervalMs = Math.max(
    MIN_INTERVAL_MS,
    options.intervalMs ?? DEFAULT_INTERVAL_MS,
  );
  const schedule = options.schedule ?? D30_500_USDC_SCHEDULE;
  const log = options.logger;

  let running = false;
  let stopped = false;
  let lastTick: Promise<unknown> = Promise.resolve();

  const runOnce = async (): Promise<CapUpgradeOutcome> => {
    const outcome = await runCapUpgrade({
      db: options.db,
      betaConfig: options.betaConfig,
      broadcaster: options.broadcaster,
      schedule,
      ...(options.thresholds ? { thresholds: options.thresholds } : {}),
      ...(log ? { logger: log } : {}),
    });
    if (options.onResult) {
      try {
        await options.onResult(outcome);
      } catch (err) {
        log?.error("cap_upgrade_cron.on_result_failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return outcome;
  };

  const guardedTick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await runOnce();
    } catch (err) {
      log?.error("cap_upgrade_cron.tick_crashed", {
        event: schedule.eventName,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    lastTick = guardedTick();
  }, intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  log?.info("cap_upgrade_cron.started", {
    event: schedule.eventName,
    intervalMs,
    triggerAfterDays: schedule.triggerAfterDays,
    amountBaseUnits: schedule.maxInvoiceBaseUnits.toString(),
  });

  return {
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await lastTick;
    },
    async tick(): Promise<CapUpgradeOutcome> {
      return runOnce();
    },
  };
}
