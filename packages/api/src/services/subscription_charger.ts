import type { Database as Db } from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";
import {
  advanceChargeDate,
  listDueSubscriptions,
  recordSubscriptionCharge,
  recordSubscriptionFailure,
  type Subscription,
} from "../db/subscriptions.js";
import { findMerchantById } from "../db/merchants.js";
import { appendAudit } from "../db/audit_journal.js";
import { insertPayment, markPaymentCompleted, markPaymentFailed, markPaymentProcessing } from "../db/payments.js";
import { newId } from "../lib/id.js";
import { withSpan } from "../lib/tracer.js";
import {
  SubscriptionAuthError,
  verifySubscriptionAuthorization,
} from "../lib/subscription-auth.js";
import type { SolanaService } from "./solana.js";
import type { Logger } from "../lib/logger.js";

export type ChargeOutcome =
  | { status: "charged"; subscription: Subscription; paymentId: string; signature: string }
  | { status: "skipped"; subscription: Subscription; reason: string }
  | { status: "failed"; subscription: Subscription; reason: string };

export interface ChargeDueOptions {
  /** Cap on how many subscriptions are processed in a single tick. */
  batchSize?: number;
  /** Reference time used to determine which subscriptions are due. */
  now?: Date;
  /** Consecutive failures after which the subscription auto-pauses. */
  pauseAfterFailures?: number;
  logger?: Logger;
}

/**
 * Z12.4 — drain due subscriptions. For each row whose `next_charge_at <= now`
 * and whose authorization signature still verifies against the live binding,
 * a payment is created via SolanaService and the row is advanced to its next
 * cycle. Authorization or transfer failures increment `failed_charge_count`
 * and emit an audit row; three consecutive failures pause the subscription.
 *
 * The function is intentionally synchronous-shaped (one charge at a time,
 * sequential awaits) so two cron workers running concurrently cannot race
 * each other into double-charging the same subscription within a single
 * tick — the recordSubscriptionCharge UPDATE moves next_charge_at out of the
 * "due" window before the loop visits the next row.
 */
export async function chargeDueSubscriptions(
  db: Db,
  solana: SolanaService,
  options: ChargeDueOptions = {},
): Promise<ChargeOutcome[]> {
  const now = options.now ?? new Date();
  const batchSize = options.batchSize ?? 50;
  const pauseAfter = options.pauseAfterFailures ?? 3;
  const log = options.logger;

  const due = listDueSubscriptions(db, now.toISOString(), batchSize);
  if (due.length === 0) {
    return [];
  }

  const outcomes: ChargeOutcome[] = [];
  for (const subscription of due) {
    const outcome = await chargeOne(db, solana, subscription, {
      now,
      pauseAfter,
      ...(log ? { logger: log } : {}),
    });
    outcomes.push(outcome);
  }
  return outcomes;
}

interface ChargeOneOptions {
  now: Date;
  pauseAfter: number;
  logger?: Logger;
}

async function chargeOne(
  db: Db,
  solana: SolanaService,
  subscription: Subscription,
  options: ChargeOneOptions,
): Promise<ChargeOutcome> {
  return withSpan(
    "zettapay.subscription.charge",
    {
      "zettapay.subscription.id": subscription.id,
      "zettapay.merchant.id": subscription.merchantId,
      "zettapay.payment.amount": subscription.amount,
      "zettapay.payment.currency": subscription.currency,
    },
    async (span) => {
      const auth = subscription.authorization;
      if (!auth) {
        return failCharge(
          db,
          subscription,
          "missing_authorization",
          options,
          span,
        );
      }
      try {
        verifySubscriptionAuthorization({
          binding: {
            subscriptionId: subscription.id,
            merchantId: subscription.merchantId,
            customerWallet: subscription.customerWallet,
            amount: subscription.amount,
            currency: subscription.currency,
            interval: subscription.interval,
          },
          publicKey: auth.publicKey,
          signature: auth.signature,
        });
      } catch (err) {
        const code =
          err instanceof SubscriptionAuthError ? err.code : "invalid_signature";
        return failCharge(db, subscription, `auth:${code}`, options, span);
      }

      const merchant = findMerchantById(db, subscription.merchantId);
      if (!merchant) {
        return failCharge(
          db,
          subscription,
          "merchant_not_found",
          options,
          span,
        );
      }

      const paymentId = newId("pay");
      insertPayment(db, {
        id: paymentId,
        merchantId: merchant.id,
        amountUsdc: subscription.amount,
        payerWallet: subscription.customerWallet,
        metadata: {
          source: "subscription",
          subscriptionId: subscription.id,
          interval: subscription.interval,
        },
        currency: subscription.currency,
        agentIdentityId: null,
      });
      markPaymentProcessing(db, paymentId);

      try {
        const result = await solana.transferToken({
          recipientOwner: new PublicKey(merchant.walletAddress),
          amount: subscription.amount,
          currency: subscription.currency,
        });
        markPaymentCompleted(db, paymentId, result.signature);

        const advanced = advanceChargeDate(
          new Date(subscription.nextChargeAt),
          subscription.interval,
        ).toISOString();
        const updated = recordSubscriptionCharge(
          db,
          subscription.id,
          options.now.toISOString(),
          advanced,
        );
        appendAudit(db, {
          actor: `subscription:${subscription.id}`,
          event: "subscription.charged",
          entityType: "subscription",
          entityId: subscription.id,
          payload: {
            paymentId,
            amount: subscription.amount,
            currency: subscription.currency,
            interval: subscription.interval,
            nextChargeAt: advanced,
            txSignature: result.signature,
          },
        });
        span.setAttribute("zettapay.subscription.outcome", "charged");
        options.logger?.info("subscription_charger.charged", {
          subscriptionId: subscription.id,
          paymentId,
          merchantId: merchant.id,
          amount: subscription.amount,
        });
        return {
          status: "charged",
          subscription: updated,
          paymentId,
          signature: result.signature,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        markPaymentFailed(db, paymentId, message);
        return failCharge(
          db,
          subscription,
          `transfer:${message}`,
          options,
          span,
          paymentId,
        );
      }
    },
  );
}

function failCharge(
  db: Db,
  subscription: Subscription,
  reason: string,
  options: ChargeOneOptions,
  span: { setAttribute: (k: string, v: string) => void },
  paymentId?: string,
): ChargeOutcome {
  const updated = recordSubscriptionFailure(
    db,
    subscription.id,
    reason,
    options.pauseAfter,
  );
  appendAudit(db, {
    actor: `subscription:${subscription.id}`,
    event: "subscription.charge_failed",
    entityType: "subscription",
    entityId: subscription.id,
    reason,
    payload: {
      paymentId: paymentId ?? null,
      failedChargeCount: updated.failedChargeCount,
      status: updated.status,
    },
  });
  span.setAttribute("zettapay.subscription.outcome", "failed");
  options.logger?.warn("subscription_charger.failed", {
    subscriptionId: subscription.id,
    reason,
    failedChargeCount: updated.failedChargeCount,
    status: updated.status,
  });
  return { status: "failed", subscription: updated, reason };
}
