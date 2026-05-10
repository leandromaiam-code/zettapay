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
import { appendAudit } from "../db/audit_journal.js";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { withSpan } from "../lib/tracer.js";
import type { SolanaService } from "./solana.js";
import type { CoinflowClient } from "../coinflow/client.js";
import { settlePayment } from "../coinflow/service.js";
import { enforceVelocityLimits } from "./velocity.js";
import { enforceAgentSpendingLimits } from "./agent-spending-limits.js";

export interface CreatePaymentInput {
  merchantId: string;
  amountUsdc: number;
  payerWallet: string | null;
  metadata: Record<string, unknown> | null;
  currency?: Currency;
  /** Verified agent identity from `agentIdentityMiddleware` (Z20.3). When set,
   * per-agent spending limits are enforced and the payment row is tagged. */
  agentIdentityId?: string | null;
}

export interface PaymentResult {
  payment: Payment;
}

export interface CreatePaymentDeps {
  /** Optional Coinflow client; when present + merchant has auto-settle enabled,
   * a settlement is fired-and-forgotten after a successful payment. Errors are
   * swallowed so settlement failures never roll back a confirmed USDC transfer. */
  coinflow?: CoinflowClient;
  /** Hook invoked after auto-settle completes (success or swallow). Test seam. */
  onAutoSettle?: (paymentId: string, err: Error | null) => void;
}

/**
 * Creates a payment record, executes the on-chain SPL transfer
 * (payer ATA → merchant ATA for the chosen currency mint), and persists
 * the resulting tx signature. Each currency lands in its own SPL token
 * account on the merchant wallet — the ATA is derived per-mint.
 * On any failure the payment is left in `failed` status with the error message.
 */
export async function createPayment(
  db: Db,
  solana: SolanaService,
  input: CreatePaymentInput,
  deps: CreatePaymentDeps = {},
): Promise<PaymentResult> {
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }

  const merchantPubkey = new PublicKey(merchant.walletAddress);
  const currency: Currency = input.currency ?? DEFAULT_CURRENCY;

  const paymentId = newId("pay");
  const payerWallet = input.payerWallet ?? solana.getPayerPublicKey().toBase58();

  return withSpan(
    "zettapay.payment.create",
    {
      "zettapay.payment.id": paymentId,
      "zettapay.merchant.id": merchant.id,
      "zettapay.payment.amount": input.amountUsdc,
      "zettapay.payment.currency": currency,
    },
    async (span) => {
      // Z13.1 fraud gate: must run BEFORE insertPayment so the in-flight attempt
      // doesn't get counted in its own window.
      enforceVelocityLimits(db, {
        merchant,
        payerWallet,
        amount: input.amountUsdc,
      });

      // Z20.3: per-agent spending caps + freeze gate. Same ordering rule —
      // run BEFORE insertPayment so the new attempt doesn't count itself.
      if (input.agentIdentityId) {
        enforceAgentSpendingLimits(db, {
          merchantId: merchant.id,
          agentIdentityId: input.agentIdentityId,
          amount: input.amountUsdc,
        });
      }

      insertPayment(db, {
        id: paymentId,
        merchantId: merchant.id,
        amountUsdc: input.amountUsdc,
        payerWallet,
        metadata: input.metadata,
        currency,
        agentIdentityId: input.agentIdentityId ?? null,
      });

      markPaymentProcessing(db, paymentId);

      try {
        const result = await solana.transferToken({
          recipientOwner: merchantPubkey,
          amount: input.amountUsdc,
          currency,
        });
        markPaymentCompleted(db, paymentId, result.signature);
        span.setAttribute("zettapay.payment.tx_signature", result.signature);
        span.setAttribute("zettapay.payment.status", "completed");

        if (
          deps.coinflow &&
          merchant.coinflow.enabled &&
          merchant.coinflow.autoSettle
        ) {
          void settlePayment(db, deps.coinflow, {
            merchantId: merchant.id,
            paymentId,
          })
            .then(() => deps.onAutoSettle?.(paymentId, null))
            .catch((err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              deps.onAutoSettle?.(paymentId, error);
            });
        }

        return { payment: getPayment(db, paymentId) };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "unknown transfer error";
        markPaymentFailed(db, paymentId, message);
        span.setAttribute("zettapay.payment.status", "failed");
        appendAudit(db, {
          actor: `payer:${payerWallet}`,
          event: "payment.failed",
          entityType: "payment",
          entityId: paymentId,
          reason: message,
          payload: {
            merchantId: merchant.id,
            amountUsdc: input.amountUsdc,
            currency,
          },
        });
        if (err instanceof HttpError) throw err;
        throw HttpError.paymentFailed(`${currency} transfer failed: ${message}`);
      }
    },
  );
}
