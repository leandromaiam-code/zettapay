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
import { recordPaymentOutcome } from "../lib/metrics.js";
import { withSpan } from "../lib/tracer.js";
import type { SolanaService } from "./solana.js";
import type { CoinflowClient } from "../coinflow/client.js";
import { settlePayment } from "../coinflow/service.js";
import { enforceVelocityLimits } from "./velocity.js";
import { enforceAgentSpendingLimits } from "./agent-spending-limits.js";
import { enforceBlacklist } from "./blacklist.js";
import { enforceBetaLimits } from "../beta/enforcer.js";
import { loadBetaConfig, type BetaLaunchConfig } from "../beta/config.js";
import type { PixClient, PixProvider } from "../pix/client.js";
import { settlePaymentToPix } from "../pix/service.js";
import {
  DEFAULT_AML_CONFIG,
  evaluatePayment,
  type AmlMonitorConfig,
} from "./aml.js";
import { appendAudit } from "../db/audit_journal.js";

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
  /** Hook invoked after Coinflow auto-settle completes (success or swallow). Test seam. */
  onAutoSettle?: (paymentId: string, err: Error | null) => void;
  /** Z22.1 beta launch protocol config. Defaults to env-driven loadBetaConfig().
   * No-op when `enabled=false`. Test seam: pass an override to exercise the gate
   * without touching process.env. */
  betaConfig?: BetaLaunchConfig;
  /** Resolves a configured PixClient for the merchant's chosen provider. When
   * the resolver returns a client AND the merchant has Pix auto-settle on,
   * a BRL Pix payout is fired-and-forgotten. */
  pix?: (provider: PixProvider) => PixClient | undefined;
  /** Hook invoked after Pix auto-settle completes (success or swallow). Test seam. */
  onAutoPixSettle?: (paymentId: string, err: Error | null) => void;
  /** AML monitoring config override (Z21.2). Defaults to DEFAULT_AML_CONFIG;
   * pass `null` to disable post-payment AML evaluation entirely. */
  amlConfig?: AmlMonitorConfig | null;
  /** Hook invoked after AML evaluation completes. Test seam. */
  onAmlEvaluated?: (
    paymentId: string,
    alertCount: number,
    err: Error | null,
  ) => void;
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

  const betaConfig = deps.betaConfig ?? loadBetaConfig();

  return withSpan(
    "zettapay.payment.create",
    {
      "zettapay.payment.id": paymentId,
      "zettapay.merchant.id": merchant.id,
      "zettapay.payment.amount": input.amountUsdc,
      "zettapay.payment.currency": currency,
    },
    async (span) => {
      // Z13.2 sanctions gate: hard-block payer/merchant wallets on the OFAC
      // SDN list before any other check so a sanctioned attempt never
      // consumes a velocity slot, beta cap, or DB row.
      enforceBlacklist(db, {
        payerWallet,
        merchantWallet: merchant.walletAddress,
        merchantId: merchant.id,
        paymentId,
      });

      // Z22.1 beta gate: allowlist + $10k cap + window expiry. No-op when disabled.
      // Runs before velocity so an out-of-cohort attempt never consumes a velocity slot.
      enforceBetaLimits(db, betaConfig, {
        merchant,
        amount: input.amountUsdc,
      });

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
        recordPaymentOutcome("completed", currency, input.amountUsdc);

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

        const finalPayment = getPayment(db, paymentId);

        // Z21.2 AML monitoring — run synchronously after settlement is dispatched
        // but before returning. Errors are swallowed + audited so the payment
        // result is never blocked by monitoring infra failures (premissa #14:
        // we do not custody, so post-transfer monitoring is detective, not
        // preventative; preventative gating is the velocity service above).
        if (deps.amlConfig !== null) {
          try {
            const result = evaluatePayment(
              db,
              { payment: finalPayment },
              deps.amlConfig ?? DEFAULT_AML_CONFIG,
            );
            deps.onAmlEvaluated?.(paymentId, result.alerts.length, null);
          } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            try {
              appendAudit(db, {
                actor: `merchant:${merchant.id}`,
                event: "aml.evaluate.error",
                payload: { paymentId, error: error.message },
              });
            } catch {
              // ignore — audit failure must not break the payment path.
            }
            deps.onAmlEvaluated?.(paymentId, 0, error);
          }
        }

        return { payment: finalPayment };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "unknown transfer error";
        markPaymentFailed(db, paymentId, message);
        span.setAttribute("zettapay.payment.status", "failed");
        recordPaymentOutcome("failed", currency, input.amountUsdc);
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
    if (
      deps.pix &&
      merchant.pix.enabled &&
      merchant.pix.autoSettle &&
      merchant.pix.provider
    ) {
      const pixClient = deps.pix(merchant.pix.provider);
      if (pixClient) {
        void settlePaymentToPix(db, pixClient, {
          merchantId: merchant.id,
          paymentId,
        })
          .then(() => deps.onAutoPixSettle?.(paymentId, null))
          .catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            deps.onAutoPixSettle?.(paymentId, error);
          });
      }
    }

    return { payment: getPayment(db, paymentId) };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "unknown transfer error";
    markPaymentFailed(db, paymentId, message);
    if (err instanceof HttpError) throw err;
    throw HttpError.paymentFailed(`${currency} transfer failed: ${message}`);
  }
}
