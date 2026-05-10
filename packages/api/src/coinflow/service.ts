import type { Database as Db } from "better-sqlite3";
import { findMerchantById, updateMerchantCoinflow } from "../db/merchants.js";
import {
  findSettlementByPayment,
  insertSettlement,
  markSettlementCompleted,
  markSettlementFailed,
  markSettlementProcessing,
  type Settlement,
} from "../db/coinflow_settlements.js";
import { getPayment } from "../db/payments.js";
import { appendAudit } from "../db/audit_journal.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { computeSettlementFee, COINFLOW_FEE_BPS } from "./fee.js";
import type { CoinflowClient } from "./client.js";

export interface EnableSettlementInput {
  coinflowMerchantId: string;
  bankAccountId: string;
  autoSettle: boolean;
}

/**
 * Persist Coinflow settlement preferences for a merchant. The merchant must
 * already exist; the call is idempotent at the row level (re-enabling with
 * different bank details simply overwrites the row).
 */
export function enableCoinflowSettlement(
  db: Db,
  merchantId: string,
  input: EnableSettlementInput,
): void {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  updateMerchantCoinflow(db, merchantId, {
    enabled: true,
    autoSettle: input.autoSettle,
    coinflowMerchantId: input.coinflowMerchantId,
    bankAccountId: input.bankAccountId,
  });
  appendAudit(db, {
    actor: `merchant:${merchantId}`,
    event: "settlement.coinflow.enabled",
    entityType: "merchant",
    entityId: merchantId,
    reason: "merchant enabled fiat settlement via Coinflow",
    payload: {
      autoSettle: input.autoSettle,
      coinflowMerchantId: input.coinflowMerchantId,
      bankAccountId: input.bankAccountId,
    },
  });
}

export function disableCoinflowSettlement(db: Db, merchantId: string): void {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  updateMerchantCoinflow(db, merchantId, {
    enabled: false,
    autoSettle: false,
    coinflowMerchantId: null,
    bankAccountId: null,
  });
  appendAudit(db, {
    actor: `merchant:${merchantId}`,
    event: "settlement.coinflow.disabled",
    entityType: "merchant",
    entityId: merchantId,
    reason: "merchant disabled fiat settlement",
  });
}

export interface SettlePaymentInput {
  merchantId: string;
  paymentId: string;
}

/**
 * Settle a single completed USDC payment to USD via Coinflow. Records the
 * settlement row first (capturing fee + net), then calls Coinflow's withdraw
 * API and finalizes the row with the resulting withdrawal ID. On any failure
 * the row is left in `failed` status with the upstream error message.
 *
 * Idempotent at the payment level: a second call for the same paymentId
 * returns the existing settlement instead of creating a duplicate withdrawal.
 */
export async function settlePayment(
  db: Db,
  client: CoinflowClient,
  input: SettlePaymentInput,
): Promise<Settlement> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  if (
    !merchant.coinflow.enabled ||
    !merchant.coinflow.coinflowMerchantId ||
    !merchant.coinflow.bankAccountId
  ) {
    throw HttpError.badRequest(
      "Merchant has not enabled Coinflow settlement",
    );
  }

  const payment = getPayment(db, input.paymentId);
  if (payment.merchantId !== merchant.id) {
    throw HttpError.notFound(
      `Payment ${input.paymentId} does not belong to merchant ${merchant.id}`,
    );
  }
  if (payment.status !== "completed") {
    throw HttpError.badRequest(
      `Payment ${payment.id} is ${payment.status} — only completed payments are settleable`,
    );
  }

  const existing = findSettlementByPayment(db, payment.id);
  if (existing) return existing;

  const fee = computeSettlementFee(payment.amountUsdc, COINFLOW_FEE_BPS);
  const settlement = insertSettlement(db, {
    id: newId("cfs"),
    merchantId: merchant.id,
    paymentId: payment.id,
    amountUsdc: fee.amountUsdc,
    feeUsdc: fee.feeUsdc,
    netUsdc: fee.netUsdc,
    feeBps: fee.feeBps,
    bankAccountId: merchant.coinflow.bankAccountId,
  });

  markSettlementProcessing(db, settlement.id);

  try {
    const response = await client.createWithdrawal({
      coinflowMerchantId: merchant.coinflow.coinflowMerchantId,
      bankAccountId: merchant.coinflow.bankAccountId,
      netUsdc: fee.netUsdc,
      idempotencyKey: settlement.id,
      metadata: { zettapayPaymentId: payment.id },
    });
    if (response.status === "failed") {
      markSettlementFailed(
        db,
        settlement.id,
        "coinflow returned failed status",
      );
      appendAudit(db, {
        actor: "provider:coinflow",
        event: "settlement.failed",
        entityType: "settlement",
        entityId: settlement.id,
        reason: "coinflow returned failed status",
        payload: {
          merchantId: merchant.id,
          paymentId: payment.id,
          netUsdc: fee.netUsdc,
        },
      });
    } else {
      markSettlementCompleted(db, settlement.id, response.withdrawalId);
      appendAudit(db, {
        actor: "provider:coinflow",
        event: "settlement.completed",
        entityType: "settlement",
        entityId: settlement.id,
        reason: "coinflow withdrawal succeeded",
        payload: {
          merchantId: merchant.id,
          paymentId: payment.id,
          withdrawalId: response.withdrawalId,
          netUsdc: fee.netUsdc,
          feeUsdc: fee.feeUsdc,
        },
      });
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown coinflow error";
    markSettlementFailed(db, settlement.id, message);
    appendAudit(db, {
      actor: "provider:coinflow",
      event: "settlement.failed",
      entityType: "settlement",
      entityId: settlement.id,
      reason: message,
      payload: { merchantId: merchant.id, paymentId: payment.id },
    });
    throw HttpError.upstream(`Coinflow settlement failed: ${message}`);
  }

  return findSettlementByPayment(db, payment.id) ?? settlement;
}
