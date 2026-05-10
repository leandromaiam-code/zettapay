import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import {
  insertPayment,
  markPaymentCompleted,
  markPaymentFailed,
  markPaymentProcessing,
  getPayment,
  type Payment,
  type PaymentChain,
} from "../db/payments.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import {
  isHexAddress,
  type EvmChain,
  type EvmCurrency,
} from "../lib/chains.js";
import { EvmService } from "./evm.js";

export interface CreateEvmPaymentInput {
  merchantId: string;
  chain: EvmChain;
  amount: number;
  /** Optional EVM address override; falls back to the merchant's bound EVM wallet. */
  recipientWallet?: `0x${string}` | null;
  /** Optional payer EVM address recorded on the payment row. Defaults to facilitator. */
  payerWallet?: `0x${string}` | null;
  metadata: Record<string, unknown> | null;
  currency?: EvmCurrency;
}

export interface EvmPaymentResult {
  payment: Payment;
  txHash: `0x${string}`;
  chainId: number;
  contractAddress: `0x${string}`;
}

/**
 * Creates a payment row, fires the ERC-20 transfer via viem, and persists
 * the resulting tx hash in `payments.tx_signature`. The row's `chain` field
 * pins the payment to its EVM origin so downstream services (settlement,
 * webhooks, refunds) can route correctly.
 */
export async function createEvmPayment(
  db: Db,
  evm: EvmService,
  input: CreateEvmPaymentInput,
): Promise<EvmPaymentResult> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }
  if (!evm.hasPayer()) {
    throw HttpError.config(
      "EVM_PAYER_PRIVATE_KEY is not configured — /pay/evm is disabled",
    );
  }

  const recipient = input.recipientWallet;
  if (!recipient || !isHexAddress(recipient)) {
    throw HttpError.badRequest(
      `Field "recipientWallet" is required for /pay/evm — pass the merchant's EVM address (0x...)`,
    );
  }

  const paymentId = newId("pay");
  const payerWallet = input.payerWallet ?? evm.getPayerAddress();
  const chainAsPaymentChain = input.chain as PaymentChain;

  insertPayment(db, {
    id: paymentId,
    merchantId: merchant.id,
    amountUsdc: input.amount,
    payerWallet,
    metadata: {
      ...(input.metadata ?? {}),
      evm: {
        chain: input.chain,
        recipientWallet: recipient,
      },
    },
    currency: input.currency ?? "USDC",
    chain: chainAsPaymentChain,
  });

  markPaymentProcessing(db, paymentId);

  try {
    const result = await evm.transferToken({
      chain: input.chain,
      recipient,
      amount: input.amount,
      currency: input.currency,
    });
    markPaymentCompleted(db, paymentId, result.txHash);
    return {
      payment: getPayment(db, paymentId),
      txHash: result.txHash,
      chainId: result.chainId,
      contractAddress: result.contractAddress,
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown EVM transfer error";
    markPaymentFailed(db, paymentId, message);
    if (err instanceof HttpError) throw err;
    throw HttpError.paymentFailed(
      `${input.currency ?? "USDC"} transfer failed on ${input.chain}: ${message}`,
    );
  }
}
