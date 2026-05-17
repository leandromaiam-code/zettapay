// Z51 — sweep worker.
//
// Consolidates the per-invoice deposit addresses derived by Z45 (HD wallet)
// into a single hot wallet per chain family (BTC + EVM). One private key per
// invoice means funds end up scattered across thousands of addresses; without
// a periodic sweep the merchant has no usable balance, just dust.
//
// The service is split into pure orchestration (this file) plus pluggable
// adapters for storage, BTC, EVM, and audit. The Vercel cron entry in
// /api/cron/sweep.ts and the long-running container cron in cron-worker.ts
// both feed the same orchestrator with their own adapter wiring.
//
// Idempotency contract: a confirmed-unswept invoice is re-attempted every
// tick until either (a) markSwept() succeeds against the on-chain
// consolidation tx, or (b) the adapter reports a permanent skip reason
// (e.g. balance below dust threshold). Re-execution after a crash that
// recorded sweep_tx_hash but lost the row update is safe because the
// store's isOnchainConfirmed() check guards the markSwept call.

export type ChainFamily = "btc" | "base" | "polygon" | "ethereum";

export interface SweepableInvoice {
  id: string;
  merchantId: string;
  chain: ChainFamily;
  derivationPath: string;
  receiveAddress: string;
  amountNative: string;
  sweepAttempts: number;
  sweepTxHash: string | null;
}

export interface SweepInvoiceStore {
  listConfirmedUnswept(limit: number): Promise<SweepableInvoice[]>;
  markSweepAttempt(invoiceId: string): Promise<void>;
  markSwept(invoiceId: string, sweepTxHash: string): Promise<void>;
  isOnchainConfirmed(chain: ChainFamily, sweepTxHash: string): Promise<boolean>;
}

export type SweeperOutcome =
  | { kind: "swept"; txHash: string }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

export interface BtcSweeper {
  consolidate(args: {
    derivationPath: string;
    fromAddress: string;
    treasuryAddress: string;
  }): Promise<SweeperOutcome>;
}

export interface EvmSweeper {
  sweepUsdc(args: {
    chain: "base" | "polygon" | "ethereum";
    derivationPath: string;
    fromAddress: string;
    treasuryAddress: string;
  }): Promise<SweeperOutcome>;
}

export interface SweepAlerter {
  notifyConsecutiveFailures(args: {
    chain: ChainFamily;
    consecutive: number;
    lastReason: string;
  }): Promise<void>;
}

export interface SweepAuditLogger {
  record(args: {
    invoiceId: string;
    chain: ChainFamily;
    outcome: SweeperOutcome;
  }): Promise<void>;
}

export interface SweepConfig {
  intervalMs: number;
  batchLimit: number;
  consecutiveFailureAlertThreshold: number;
  treasury: {
    btc: string | null;
    evm: string | null;
  };
}

export interface SweepDeps {
  store: SweepInvoiceStore;
  btc: BtcSweeper;
  evm: EvmSweeper;
  audit: SweepAuditLogger;
  alerter: SweepAlerter;
  config: SweepConfig;
  clock?: () => number;
  logger?: { info: (msg: string, ctx?: unknown) => void; warn: (msg: string, ctx?: unknown) => void; error: (msg: string, ctx?: unknown) => void };
}

export interface SweepTickResult {
  attempted: number;
  swept: number;
  skipped: number;
  failed: number;
  outcomes: Array<{ invoiceId: string; outcome: SweeperOutcome }>;
}

const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_FAILURE_ALERT = 3;

export function readSweepConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SweepConfig {
  const minutesRaw = env.SWEEP_INTERVAL_MINUTES;
  const minutes = minutesRaw ? Number.parseInt(minutesRaw, 10) : 60;
  const intervalMs = Number.isFinite(minutes) && minutes > 0
    ? minutes * 60 * 1000
    : DEFAULT_INTERVAL_MS;
  const batchRaw = env.SWEEP_BATCH_LIMIT;
  const batchLimit = batchRaw ? Number.parseInt(batchRaw, 10) : DEFAULT_BATCH_LIMIT;
  const alertRaw = env.SWEEP_FAILURE_ALERT_THRESHOLD;
  const alert = alertRaw ? Number.parseInt(alertRaw, 10) : DEFAULT_FAILURE_ALERT;
  return {
    intervalMs,
    batchLimit: Number.isFinite(batchLimit) && batchLimit > 0 ? batchLimit : DEFAULT_BATCH_LIMIT,
    consecutiveFailureAlertThreshold: Number.isFinite(alert) && alert > 0 ? alert : DEFAULT_FAILURE_ALERT,
    treasury: {
      btc: env.BTC_TREASURY_ADDRESS?.trim() || null,
      evm: env.EVM_TREASURY_ADDRESS?.trim() || null,
    },
  };
}

function chainFamilyOf(chain: ChainFamily): "btc" | "evm" {
  return chain === "btc" ? "btc" : "evm";
}

/**
 * Sweep a single invoice. Pure: returns the outcome rather than acting on
 * the store directly, so callers can choose whether to persist or replay.
 *
 * The on-chain confirmation re-check covers the "we crashed after broadcast
 * but before marking swept_at" race: if the prior attempt's tx is already
 * confirmed, we treat the invoice as swept without re-broadcasting.
 */
export async function sweepInvoice(
  invoice: SweepableInvoice,
  deps: SweepDeps,
): Promise<SweeperOutcome> {
  if (invoice.sweepTxHash) {
    const confirmed = await deps.store.isOnchainConfirmed(invoice.chain, invoice.sweepTxHash);
    if (confirmed) {
      return { kind: "swept", txHash: invoice.sweepTxHash };
    }
  }
  if (invoice.chain === "btc") {
    if (!deps.config.treasury.btc) {
      return { kind: "skipped", reason: "BTC_TREASURY_ADDRESS not configured" };
    }
    return deps.btc.consolidate({
      derivationPath: invoice.derivationPath,
      fromAddress: invoice.receiveAddress,
      treasuryAddress: deps.config.treasury.btc,
    });
  }
  if (!deps.config.treasury.evm) {
    return { kind: "skipped", reason: "EVM_TREASURY_ADDRESS not configured" };
  }
  return deps.evm.sweepUsdc({
    chain: invoice.chain,
    derivationPath: invoice.derivationPath,
    fromAddress: invoice.receiveAddress,
    treasuryAddress: deps.config.treasury.evm,
  });
}

/**
 * One sweep pass: pull confirmed-unswept rows, attempt each, persist the
 * resulting state. Returns a structured summary used by both the cron tick
 * caller and the test suite.
 *
 * Consecutive-failure tracking is per chain family (btc vs evm) because an
 * RPC outage on one family must not silence alerting on the other.
 */
export async function sweepOnce(deps: SweepDeps): Promise<SweepTickResult> {
  const log = deps.logger ?? defaultLogger();
  const invoices = await deps.store.listConfirmedUnswept(deps.config.batchLimit);
  const result: SweepTickResult = { attempted: 0, swept: 0, skipped: 0, failed: 0, outcomes: [] };
  const consecutiveFailures: Record<"btc" | "evm", { count: number; lastReason: string }> = {
    btc: { count: 0, lastReason: "" },
    evm: { count: 0, lastReason: "" },
  };

  for (const invoice of invoices) {
    result.attempted += 1;
    await deps.store.markSweepAttempt(invoice.id).catch((err: unknown) => {
      log.warn("sweep.markSweepAttempt failed", { invoiceId: invoice.id, err: errorMessage(err) });
    });
    let outcome: SweeperOutcome;
    try {
      outcome = await sweepInvoice(invoice, deps);
    } catch (err) {
      outcome = { kind: "failed", reason: errorMessage(err) };
    }
    result.outcomes.push({ invoiceId: invoice.id, outcome });
    await deps.audit.record({ invoiceId: invoice.id, chain: invoice.chain, outcome }).catch((err: unknown) => {
      log.warn("sweep.audit.record failed", { invoiceId: invoice.id, err: errorMessage(err) });
    });
    const family = chainFamilyOf(invoice.chain);
    if (outcome.kind === "swept") {
      result.swept += 1;
      consecutiveFailures[family] = { count: 0, lastReason: "" };
      await deps.store.markSwept(invoice.id, outcome.txHash).catch((err: unknown) => {
        log.error("sweep.markSwept failed", { invoiceId: invoice.id, err: errorMessage(err) });
      });
    } else if (outcome.kind === "skipped") {
      result.skipped += 1;
    } else {
      result.failed += 1;
      const tracker = consecutiveFailures[family];
      tracker.count += 1;
      tracker.lastReason = outcome.reason;
      if (tracker.count >= deps.config.consecutiveFailureAlertThreshold) {
        await deps.alerter
          .notifyConsecutiveFailures({
            chain: invoice.chain,
            consecutive: tracker.count,
            lastReason: tracker.lastReason,
          })
          .catch((err: unknown) => {
            log.warn("sweep.alerter.notify failed", { err: errorMessage(err) });
          });
      }
    }
  }

  log.info("sweep.tick", {
    attempted: result.attempted,
    swept: result.swept,
    skipped: result.skipped,
    failed: result.failed,
  });
  return result;
}

export interface SweepCronHandle {
  stop: () => Promise<void>;
}

/**
 * Start a long-running sweep cron suitable for the container-mode worker
 * (npm run start:cron). Vercel deployments wire the same sweepOnce()
 * orchestrator from /api/cron/sweep.ts on a Vercel-managed schedule, so
 * this entry only matters when the cron container is in use.
 */
export function startSweepCron(deps: SweepDeps): SweepCronHandle {
  let stopped = false;
  let inflight: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      await sweepOnce(deps);
    } catch (err) {
      (deps.logger ?? defaultLogger()).error("sweep.tick failed", { err: errorMessage(err) });
    } finally {
      if (!stopped) {
        timer = setTimeout(() => {
          inflight = tick();
        }, deps.config.intervalMs);
      }
    }
  };

  inflight = tick();

  return {
    stop: async () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inflight) await inflight;
    },
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function defaultLogger(): NonNullable<SweepDeps["logger"]> {
  return {
    info: (msg, ctx) => console.log(JSON.stringify({ level: "info", msg, ctx })),
    warn: (msg, ctx) => console.warn(JSON.stringify({ level: "warn", msg, ctx })),
    error: (msg, ctx) => console.error(JSON.stringify({ level: "error", msg, ctx })),
  };
}
