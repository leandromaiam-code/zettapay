import type { Database as Db } from "better-sqlite3";
import { findMerchantById, updateMerchantPix } from "../db/merchants.js";
import {
  findPixSettlementByPayment,
  insertPixSettlement,
  markPixSettlementCompleted,
  markPixSettlementFailed,
  markPixSettlementProcessing,
  type PixSettlement,
} from "../db/pix_settlements.js";
import { getPayment } from "../db/payments.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { computePixSettlementFee, PIX_FEE_BPS } from "./fee.js";
import type {
  PixClient,
  PixKeyType,
  PixProvider,
} from "./client.js";

export interface EnablePixSettlementInput {
  provider: PixProvider;
  pixKey: string;
  pixKeyType: PixKeyType;
  providerMerchantId: string | null;
  autoSettle: boolean;
}

/**
 * Persist Pix settlement preferences for a merchant. The merchant must already
 * exist; the call is idempotent at the row level (re-enabling with different
 * Pix key details simply overwrites the row).
 */
export function enablePixSettlement(
  db: Db,
  merchantId: string,
  input: EnablePixSettlementInput,
): void {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  updateMerchantPix(db, merchantId, {
    enabled: true,
    autoSettle: input.autoSettle,
    provider: input.provider,
    providerMerchantId: input.providerMerchantId,
    pixKey: input.pixKey,
    pixKeyType: input.pixKeyType,
  });
}

export function disablePixSettlement(db: Db, merchantId: string): void {
  const merchant = findMerchantById(db, merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${merchantId} not found`);
  }
  updateMerchantPix(db, merchantId, {
    enabled: false,
    autoSettle: false,
    provider: null,
    providerMerchantId: null,
    pixKey: null,
    pixKeyType: null,
  });
}

export interface SettlePixPaymentInput {
  merchantId: string;
  paymentId: string;
}

/**
 * Settle a single completed USDC payment to BRL via Pix. Records the
 * settlement row first (capturing fee + net), calls the configured Pix
 * provider's payout API, then finalizes the row with the resulting withdrawal
 * ID + BRL quote. On any failure the row is left in `failed` status with the
 * upstream error message.
 *
 * Idempotent at the payment level: a second call for the same paymentId
 * returns the existing settlement instead of creating a duplicate payout.
 *
 * The provider client passed in must match the merchant's configured
 * `pix.provider` — the caller (router or auto-settle hook) is responsible
 * for selecting the correct client.
 */
export async function settlePaymentToPix(
  db: Db,
  client: PixClient,
  input: SettlePixPaymentInput,
): Promise<PixSettlement> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  if (
    !merchant.pix.enabled ||
    !merchant.pix.provider ||
    !merchant.pix.pixKey ||
    !merchant.pix.pixKeyType
  ) {
    throw HttpError.badRequest(
      "Merchant has not enabled Pix settlement",
    );
  }
  if (merchant.pix.provider !== client.provider) {
    throw HttpError.badRequest(
      `Merchant Pix provider is "${merchant.pix.provider}" but caller supplied a "${client.provider}" client`,
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

  const existing = findPixSettlementByPayment(db, payment.id);
  if (existing) return existing;

  const fee = computePixSettlementFee(payment.amountUsdc, PIX_FEE_BPS);
  const settlement = insertPixSettlement(db, {
    id: newId("pixs"),
    merchantId: merchant.id,
    paymentId: payment.id,
    provider: client.provider,
    amountUsdc: fee.amountUsdc,
    feeUsdc: fee.feeUsdc,
    netUsdc: fee.netUsdc,
    feeBps: fee.feeBps,
    pixKey: merchant.pix.pixKey,
    pixKeyType: merchant.pix.pixKeyType,
  });

  markPixSettlementProcessing(db, settlement.id);

  try {
    const response = await client.createWithdrawal({
      netUsdc: fee.netUsdc,
      pixKey: merchant.pix.pixKey,
      pixKeyType: merchant.pix.pixKeyType,
      idempotencyKey: settlement.id,
      providerMerchantId: merchant.pix.providerMerchantId,
      metadata: { zettapayPaymentId: payment.id },
    });
    if (response.status === "failed") {
      markPixSettlementFailed(
        db,
        settlement.id,
        `${client.provider} returned failed status`,
      );
    } else {
      markPixSettlementCompleted(
        db,
        settlement.id,
        response.withdrawalId,
        response.quotedBrl,
      );
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : `unknown ${client.provider} error`;
    markPixSettlementFailed(db, settlement.id, message);
    throw HttpError.upstream(`Pix settlement failed: ${message}`);
  }

  return findPixSettlementByPayment(db, payment.id) ?? settlement;
}
