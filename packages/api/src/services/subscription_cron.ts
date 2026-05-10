import type { Database as Db } from "better-sqlite3";
import { chargeDueSubscriptions } from "./subscription_charger.js";
import type { SolanaService } from "./solana.js";
import type { Logger } from "../lib/logger.js";

export interface SubscriptionCronOptions {
  db: Db;
  solana: SolanaService;
  /** Polling interval in ms. Default: 60_000 (one minute). */
  intervalMs?: number;
  /** Subscriptions processed per tick. Default: 50. */
  batchSize?: number;
  logger?: Logger;
}

export interface SubscriptionCronHandle {
  /** Stop the polling loop and resolve once any in-flight tick finishes. */
  close(): Promise<void>;
  /** Trigger a tick immediately. Used by tests and manual ops triggers. */
  tick(): Promise<void>;
}

/**
 * Z12.4 — start the subscription cron loop. A single setInterval ticker fans
 * out to `chargeDueSubscriptions` every `intervalMs`. Re-entrancy is guarded
 * by a flag so a slow tick never overlaps with the next one — the queue
 * naturally absorbs the lag and resumes when the previous batch resolves.
 *
 * Each tick is sandboxed: any thrown error is logged and swallowed so the
 * worker never crashes mid-loop. Per-subscription failures are already
 * recorded in `subscriptions.failed_charge_count` + `audit_journal`.
 */
export function startSubscriptionCron(
  options: SubscriptionCronOptions,
): SubscriptionCronHandle {
  const intervalMs = Math.max(1_000, options.intervalMs ?? 60_000);
  const batchSize = options.batchSize ?? 50;
  const log = options.logger;

  let running = false;
  let stopped = false;
  let lastTick: Promise<void> = Promise.resolve();

  const runTick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      const outcomes = await chargeDueSubscriptions(options.db, options.solana, {
        batchSize,
        ...(log ? { logger: log } : {}),
      });
      if (outcomes.length > 0) {
        const charged = outcomes.filter((o) => o.status === "charged").length;
        const failed = outcomes.filter((o) => o.status === "failed").length;
        log?.info("subscription_cron.tick_done", {
          processed: outcomes.length,
          charged,
          failed,
        });
      }
    } catch (err) {
      log?.error("subscription_cron.tick_crashed", {
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    lastTick = runTick();
  }, intervalMs);
  // Don't keep the event loop alive just for this poll — the host process
  // (HTTP server or worker boot script) owns shutdown.
  if (typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    async close(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      await lastTick;
    },
    async tick(): Promise<void> {
      lastTick = runTick();
      await lastTick;
    },
  };
}
