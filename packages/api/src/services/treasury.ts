import type { Database as Db } from "better-sqlite3";
import {
  appendAudit,
  type AuditJournalEntry,
} from "../db/audit_journal.js";
import {
  findTpvContributionByPayment,
  getCompletedTpv,
  getTreasuryTotals,
  insertTreasuryEntry,
  listTreasuryEntries,
  type ListTreasuryOptions,
  type TreasuryEntryReason,
  type TreasuryReserveEntry,
} from "../db/treasury_reserves.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { logger } from "../lib/logger.js";

/**
 * Z22.3 — Insurance/treasury reserve. Premissa #14 says we never custody USDC
 * during a normal merchant payment, but the protocol DOES need an emergency
 * pool to cover incident-driven refunds in Sprint Z22 (mainnet cutover). The
 * target balance is 5% of completed TPV; debits are recorded per refund.
 */
export const DEFAULT_TPV_RESERVE_RATIO = 0.05;
const MIN_RATIO = 0;
const MAX_RATIO = 1;
const MIN_AMOUNT_USDC = 0.000001;

export interface TreasuryServiceOptions {
  reserveRatio?: number;
}

function normalizeRatio(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_TPV_RESERVE_RATIO;
  if (!Number.isFinite(raw) || raw < MIN_RATIO || raw > MAX_RATIO) {
    throw new Error(
      `treasury reserveRatio must be a finite number in [0,1]; got ${raw}`,
    );
  }
  return raw;
}

function roundUsdc(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function requireAmount(amountUsdc: number): number {
  if (!Number.isFinite(amountUsdc) || amountUsdc < MIN_AMOUNT_USDC) {
    throw HttpError.badRequest(
      `amountUsdc must be a positive number ≥ ${MIN_AMOUNT_USDC}`,
    );
  }
  return roundUsdc(amountUsdc);
}

export function computeTpvContribution(
  paymentAmountUsdc: number,
  ratio: number = DEFAULT_TPV_RESERVE_RATIO,
): number {
  if (!Number.isFinite(paymentAmountUsdc) || paymentAmountUsdc <= 0) return 0;
  const safeRatio = normalizeRatio(ratio);
  return roundUsdc(paymentAmountUsdc * safeRatio);
}

export interface ReserveSummary {
  reserveRatio: number;
  completedTpvUsdc: number;
  completedPaymentCount: number;
  targetReserveUsdc: number;
  balanceUsdc: number;
  creditTotalUsdc: number;
  debitTotalUsdc: number;
  entryCount: number;
  /** Positive = under target (need to top up). Negative = above target. */
  deficitUsdc: number;
  /** True when balance ≥ target — Z22 mainnet gate. */
  fullyFunded: boolean;
}

export interface RecordContributionInput {
  paymentId: string;
  paymentAmountUsdc: number;
  merchantId?: string | null;
  actor?: string;
}

export interface RecordEntryInput {
  amountUsdc: number;
  reason: Extract<
    TreasuryEntryReason,
    "manual_top_up" | "incident_refund" | "operational_drawdown" | "rebalance"
  >;
  paymentId?: string | null;
  merchantId?: string | null;
  externalRef?: string | null;
  memo?: string | null;
  actor: string;
}

export class TreasuryService {
  readonly reserveRatio: number;

  constructor(
    private readonly db: Db,
    options: TreasuryServiceOptions = {},
  ) {
    this.reserveRatio = normalizeRatio(options.reserveRatio);
  }

  getSummary(): ReserveSummary {
    const totals = getTreasuryTotals(this.db);
    const tpv = getCompletedTpv(this.db);
    const target = roundUsdc(tpv.totalUsdc * this.reserveRatio);
    const balance = roundUsdc(totals.balanceUsdc);
    return {
      reserveRatio: this.reserveRatio,
      completedTpvUsdc: roundUsdc(tpv.totalUsdc),
      completedPaymentCount: tpv.paymentCount,
      targetReserveUsdc: target,
      balanceUsdc: balance,
      creditTotalUsdc: roundUsdc(totals.creditUsdc),
      debitTotalUsdc: roundUsdc(totals.debitUsdc),
      entryCount: totals.entryCount,
      deficitUsdc: roundUsdc(target - balance),
      fullyFunded: balance + 1e-9 >= target,
    };
  }

  recordTpvContribution(
    input: RecordContributionInput,
  ): TreasuryReserveEntry | null {
    const amount = computeTpvContribution(
      input.paymentAmountUsdc,
      this.reserveRatio,
    );
    if (amount <= 0) return null;
    const existing = findTpvContributionByPayment(this.db, input.paymentId);
    if (existing) return existing;

    const entry = insertTreasuryEntry(this.db, {
      id: newId("trsv"),
      kind: "credit",
      amountUsdc: amount,
      reason: "tpv_contribution",
      paymentId: input.paymentId,
      merchantId: input.merchantId ?? null,
      memo: `TPV ${(this.reserveRatio * 100).toFixed(2)}% reserve auto-contribution`,
      actor: input.actor ?? "system:treasury",
    });
    appendAudit(this.db, {
      actor: entry.actor,
      event: "treasury.reserve.tpv_contribution",
      payload: {
        entryId: entry.id,
        paymentId: input.paymentId,
        amountUsdc: amount,
        ratio: this.reserveRatio,
      },
    });
    logger.info("treasury.reserve.tpv_contribution", {
      entryId: entry.id,
      paymentId: input.paymentId,
      amountUsdc: amount,
    });
    return entry;
  }

  recordCredit(input: RecordEntryInput): TreasuryReserveEntry {
    if (input.reason === "incident_refund" || input.reason === "operational_drawdown") {
      throw HttpError.badRequest(
        `reason "${input.reason}" must be recorded as a debit, not a credit`,
      );
    }
    return this.persistEntry("credit", input);
  }

  recordDebit(input: RecordEntryInput): TreasuryReserveEntry {
    if (input.reason === "manual_top_up") {
      throw HttpError.badRequest(
        `reason "manual_top_up" must be recorded as a credit, not a debit`,
      );
    }
    const balance = getTreasuryTotals(this.db).balanceUsdc;
    const amount = requireAmount(input.amountUsdc);
    if (amount > balance + 1e-9) {
      throw HttpError.conflict(
        "treasury reserve balance is insufficient for this debit",
        {
          requestedUsdc: amount,
          availableUsdc: roundUsdc(balance),
        },
      );
    }
    return this.persistEntry("debit", input, amount);
  }

  list(options: ListTreasuryOptions = {}): TreasuryReserveEntry[] {
    return listTreasuryEntries(this.db, options);
  }

  private persistEntry(
    kind: "credit" | "debit",
    input: RecordEntryInput,
    preValidatedAmount?: number,
  ): TreasuryReserveEntry {
    const amount = preValidatedAmount ?? requireAmount(input.amountUsdc);
    const entry = insertTreasuryEntry(this.db, {
      id: newId("trsv"),
      kind,
      amountUsdc: amount,
      reason: input.reason,
      paymentId: input.paymentId ?? null,
      merchantId: input.merchantId ?? null,
      externalRef: input.externalRef ?? null,
      memo: input.memo ?? null,
      actor: input.actor,
    });
    appendAudit(this.db, {
      actor: entry.actor,
      event: `treasury.reserve.${kind}`,
      payload: {
        entryId: entry.id,
        reason: entry.reason,
        amountUsdc: amount,
        externalRef: entry.externalRef,
        paymentId: entry.paymentId,
        merchantId: entry.merchantId,
      },
    });
    logger.info(`treasury.reserve.${kind}`, {
      entryId: entry.id,
      reason: entry.reason,
      amountUsdc: amount,
    });
    return entry;
  }
}

export type AuditedTreasuryEntry = TreasuryReserveEntry & {
  audit?: AuditJournalEntry;
};
