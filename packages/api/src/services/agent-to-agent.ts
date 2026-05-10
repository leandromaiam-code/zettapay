import type { Database as Db } from "better-sqlite3";
import { PublicKey } from "@solana/web3.js";
import { findAgentIdentityById } from "../db/agent_identities.js";
import {
  getAgentToAgentPayment,
  insertAgentToAgentPayment,
  markAgentToAgentPaymentCompleted,
  markAgentToAgentPaymentFailed,
  markAgentToAgentPaymentProcessing,
  sumAgentToAgentSpendSince,
  type AgentToAgentPayment,
} from "../db/agent_to_agent_payments.js";
import { DEFAULT_CURRENCY, type Currency } from "../lib/currencies.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import { withSpan } from "../lib/tracer.js";
import type { SolanaService } from "./solana.js";

const ONE_DAY_MS = 24 * 60 * 60_000;

/**
 * Z20.4 caps. A2A is positioned for micropayments — a smaller per-tx ceiling
 * than the merchant /pay path nudges agent operators toward many small calls
 * rather than reusing this rail for high-value transfers (the merchant flow
 * is the right place for those, with KYC + spending limits + webhooks).
 */
export const AGENT_TO_AGENT_MAX_PER_REQUEST = 1_000;
export const AGENT_TO_AGENT_DAILY_CAP = 10_000;

export interface CreateAgentToAgentPaymentInput {
  payerAgentIdentityId: string;
  payeeAgentIdentityId: string;
  amountUsdc: number;
  taskRef?: string | null;
  metadata?: Record<string, unknown> | null;
  currency?: Currency;
}

export interface AgentToAgentPaymentResult {
  payment: AgentToAgentPayment;
}

/**
 * Direct payment between two registered agent identities, no merchant.
 * Verifies both ends are active, the payee has a payout wallet on file, and
 * caps the transfer to the per-tx + rolling daily ceilings before issuing
 * the SPL transfer. Failures leave the row in `failed` state so callers can
 * inspect what happened.
 */
export async function createAgentToAgentPayment(
  db: Db,
  solana: SolanaService,
  input: CreateAgentToAgentPaymentInput,
): Promise<AgentToAgentPaymentResult> {
  if (input.payerAgentIdentityId === input.payeeAgentIdentityId) {
    throw HttpError.badRequest(
      "payer and payee agent identities must differ",
    );
  }
  if (
    !Number.isFinite(input.amountUsdc) ||
    input.amountUsdc <= 0
  ) {
    throw HttpError.badRequest("amount must be a positive number");
  }
  if (input.amountUsdc > AGENT_TO_AGENT_MAX_PER_REQUEST) {
    throw HttpError.rateLimited(
      `amount ${input.amountUsdc} exceeds A2A per-tx ceiling ${AGENT_TO_AGENT_MAX_PER_REQUEST}`,
      {
        scope: "agent_to_agent:max_per_request",
        limit: AGENT_TO_AGENT_MAX_PER_REQUEST,
        attempted: input.amountUsdc,
      },
    );
  }

  const payer = findAgentIdentityById(db, input.payerAgentIdentityId);
  if (!payer) {
    throw HttpError.notFound(
      `payer agent ${input.payerAgentIdentityId} not found`,
    );
  }
  if (payer.status !== "active") {
    throw new HttpError(
      403,
      "unauthorized",
      `payer agent ${payer.id} is revoked`,
    );
  }

  const payee = findAgentIdentityById(db, input.payeeAgentIdentityId);
  if (!payee) {
    throw HttpError.notFound(
      `payee agent ${input.payeeAgentIdentityId} not found`,
    );
  }
  if (payee.status !== "active") {
    throw new HttpError(
      403,
      "unauthorized",
      `payee agent ${payee.id} is revoked`,
    );
  }
  if (!payee.payoutWallet) {
    throw HttpError.badRequest(
      `payee agent ${payee.id} has no payout wallet — cannot receive A2A payments`,
    );
  }

  let payeePubkey: PublicKey;
  try {
    payeePubkey = new PublicKey(payee.payoutWallet);
  } catch {
    throw HttpError.badRequest(
      `payee agent payout wallet is not a valid Solana address`,
    );
  }

  // Rolling 24h cap on payer's total A2A spend. Without this, a hijacked
  // payer key could drain a treasury one micropayment at a time before the
  // owner notices.
  const windowStart = new Date(Date.now() - ONE_DAY_MS).toISOString();
  const spentInWindow = sumAgentToAgentSpendSince(
    db,
    payer.id,
    windowStart,
  );
  if (spentInWindow + input.amountUsdc > AGENT_TO_AGENT_DAILY_CAP) {
    throw HttpError.rateLimited(
      `A2A daily cap of ${AGENT_TO_AGENT_DAILY_CAP} would be exceeded (already spent ${spentInWindow}, attempted ${input.amountUsdc})`,
      {
        scope: "agent_to_agent:daily_cap",
        limit: AGENT_TO_AGENT_DAILY_CAP,
        observed: spentInWindow,
        attempted: input.amountUsdc,
        windowSec: 86400,
      },
    );
  }

  const paymentId = newId("a2a");
  const currency: Currency = input.currency ?? DEFAULT_CURRENCY;
  const payerWallet = solana.getPayerPublicKey().toBase58();

  return withSpan(
    "zettapay.agent_to_agent.create",
    {
      "zettapay.a2a.id": paymentId,
      "zettapay.a2a.payer_agent": payer.id,
      "zettapay.a2a.payee_agent": payee.id,
      "zettapay.a2a.amount": input.amountUsdc,
      "zettapay.a2a.currency": currency,
    },
    async (span) => {
      insertAgentToAgentPayment(db, {
        id: paymentId,
        payerAgentIdentityId: payer.id,
        payeeAgentIdentityId: payee.id,
        payerWallet,
        payeeWallet: payee.payoutWallet as string,
        amountUsdc: input.amountUsdc,
        currency,
        taskRef: input.taskRef ?? null,
        metadata: input.metadata ?? null,
      });
      markAgentToAgentPaymentProcessing(db, paymentId);

      try {
        const result = await solana.transferToken({
          recipientOwner: payeePubkey,
          amount: input.amountUsdc,
          currency,
        });
        markAgentToAgentPaymentCompleted(db, paymentId, result.signature);
        span.setAttribute("zettapay.a2a.tx_signature", result.signature);
        span.setAttribute("zettapay.a2a.status", "completed");
        return { payment: getAgentToAgentPayment(db, paymentId) };
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "unknown transfer error";
        markAgentToAgentPaymentFailed(db, paymentId, message);
        span.setAttribute("zettapay.a2a.status", "failed");
        if (err instanceof HttpError) throw err;
        throw HttpError.paymentFailed(
          `${currency} A2A transfer failed: ${message}`,
        );
      }
    },
  );
}
