import type { Database as Db } from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";
import { findMerchantById } from "../db/merchants.js";
import {
  insertPayment,
  markPaymentCompleted,
  markPaymentFailed,
  markPaymentProcessing,
  getPayment,
  type Payment,
} from "../db/payments.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import type { SolanaService } from "./solana.js";

export interface CreatePaymentInput {
  merchantId: string;
  amountUsdc: number;
  payerWallet: string | null;
  metadata: Record<string, unknown> | null;
}

export interface PaymentResult {
  payment: Payment;
}

/**
 * Creates a payment record, executes the on-chain USDC transfer
 * (payer ATA → merchant ATA), and persists the resulting tx signature.
 * On any failure the payment is left in `failed` status with the error message.
 */
export async function createPayment(
  db: Db,
  solana: SolanaService,
  input: CreatePaymentInput,
): Promise<PaymentResult> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }

  const merchantPubkey = new PublicKey(merchant.walletAddress);

  const paymentId = newId("pay");
  const payerWallet = input.payerWallet ?? solana.getPayerPublicKey().toBase58();

  insertPayment(db, {
    id: paymentId,
    merchantId: merchant.id,
    amountUsdc: input.amountUsdc,
    payerWallet,
    metadata: input.metadata,
  });

  markPaymentProcessing(db, paymentId);

  try {
    const result = await solana.transferUsdc({
      recipientOwner: merchantPubkey,
      amountUsdc: input.amountUsdc,
    });
    markPaymentCompleted(db, paymentId, result.signature);
    return { payment: getPayment(db, paymentId) };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown transfer error";
    markPaymentFailed(db, paymentId, message);
    if (err instanceof HttpError) throw err;
    throw HttpError.paymentFailed(`USDC transfer failed: ${message}`);
  }
}
