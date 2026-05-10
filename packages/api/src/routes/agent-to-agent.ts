import { Router } from "express";
import type { Database as Db } from "better-sqlite3";
import { agentIdentityMiddleware } from "../middleware/agent-identity.js";
import { idempotency } from "../middleware/idempotency.js";
import { HttpError } from "../lib/errors.js";
import {
  isSupportedProvider,
  SUPPORTED_PROVIDERS,
} from "../lib/agent-identity.js";
import { normalizeCurrency } from "../lib/currencies.js";
import {
  optionalRecord,
  optionalString,
  requirePositiveNumber,
  requireString,
} from "../lib/validate.js";
import {
  findAgentIdentityById,
  findAgentIdentityByProviderAgent,
} from "../db/agent_identities.js";
import {
  findAgentToAgentPayment,
  listAgentToAgentPayments,
  type AgentToAgentPayment,
} from "../db/agent_to_agent_payments.js";
import { createAgentToAgentPayment } from "../services/agent-to-agent.js";
import type { SolanaService } from "../services/solana.js";

function publicView(payment: AgentToAgentPayment) {
  return {
    id: payment.id,
    payerAgentIdentityId: payment.payerAgentIdentityId,
    payeeAgentIdentityId: payment.payeeAgentIdentityId,
    payerWallet: payment.payerWallet,
    payeeWallet: payment.payeeWallet,
    amount: payment.amountUsdc,
    amountUsdc: payment.amountUsdc,
    currency: payment.currency,
    taskRef: payment.taskRef,
    status: payment.status,
    txSignature: payment.txSignature,
    metadata: payment.metadata,
    createdAt: payment.createdAt,
    completedAt: payment.completedAt,
  };
}

interface PayeeIdentifier {
  agentIdentityId: string;
}

function resolvePayee(
  db: Db,
  body: Record<string, unknown>,
): PayeeIdentifier {
  // Two ways to address the payee: by internal `payeeAgentIdentityId` or by
  // the public (provider, agentId) pair. The latter is friendlier for SDK
  // callers that already track the agent's external identifier.
  const directId = optionalString(body, "payeeAgentIdentityId", {
    maxLength: 128,
  });
  if (directId) {
    const identity = findAgentIdentityById(db, directId);
    if (!identity) {
      throw HttpError.notFound(`payee agent ${directId} not found`);
    }
    return { agentIdentityId: identity.id };
  }

  const payee = body.payee;
  if (!payee || typeof payee !== "object" || Array.isArray(payee)) {
    throw HttpError.badRequest(
      'Field "payeeAgentIdentityId" or "payee" object is required',
    );
  }
  const payeeRecord = payee as Record<string, unknown>;
  const provider = requireString(payeeRecord, "provider", { maxLength: 32 });
  if (!isSupportedProvider(provider)) {
    throw HttpError.badRequest(
      `payee.provider must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
    );
  }
  const agentId = requireString(payeeRecord, "agentId", { maxLength: 128 });
  const identity = findAgentIdentityByProviderAgent(db, provider, agentId);
  if (!identity) {
    throw HttpError.notFound(
      `no agent identity bound to (${provider}, ${agentId})`,
    );
  }
  return { agentIdentityId: identity.id };
}

const MAX_TASK_REF = 128;

export function agentToAgentRouter(
  db: Db,
  solana: SolanaService,
): Router {
  const router = Router();

  // POST /agents/pay — direct payment between two registered agents.
  // The payer authorizes via AGENT_HEADER (proves identity + key ownership);
  // the payee is addressed by either internal id or (provider, agentId).
  router.post(
    "/agents/pay",
    idempotency(db, { scope: "POST /agents/pay" }),
    agentIdentityMiddleware(db, { required: true }),
    async (req, res, next) => {
      try {
        if (!req.agentIdentity) {
          throw HttpError.unauthorized(
            "agent identity proof is required for /agents/pay",
          );
        }
        const body = (req.body ?? {}) as Record<string, unknown>;
        const { agentIdentityId: payeeAgentIdentityId } = resolvePayee(
          db,
          body,
        );
        const amount = requirePositiveNumber(
          { amount: body.amount ?? body.amountUsdc },
          "amount",
        );
        const taskRef = optionalString(body, "taskRef", {
          maxLength: MAX_TASK_REF,
        });
        const metadata = optionalRecord(body, "metadata");
        const currency = normalizeCurrency(
          optionalString(body, "currency", { maxLength: 8 }),
        );

        const { payment } = await createAgentToAgentPayment(db, solana, {
          payerAgentIdentityId: req.agentIdentity.identity.id,
          payeeAgentIdentityId,
          amountUsdc: amount,
          taskRef,
          metadata,
          currency,
        });
        res.status(201).json({ payment: publicView(payment) });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /agents/identity/:id/payments — history of A2A payments touching
  // the given agent (as payer or payee). `role` query narrows the view.
  router.get("/agents/identity/:id/payments", (req, res, next) => {
    try {
      const agentIdentityId = req.params.id ?? "";
      const identity = findAgentIdentityById(db, agentIdentityId);
      if (!identity) {
        throw HttpError.notFound(
          `agent identity ${agentIdentityId} not found`,
        );
      }
      const roleParam =
        typeof req.query.role === "string" ? req.query.role : "";
      let role: "payer" | "payee" | "any" = "any";
      if (roleParam === "payer" || roleParam === "payee") {
        role = roleParam;
      } else if (roleParam !== "" && roleParam !== "any") {
        throw HttpError.badRequest(
          'Query "role" must be one of: payer, payee, any',
        );
      }
      const limitParam =
        typeof req.query.limit === "string" ? Number(req.query.limit) : NaN;
      const limit = Number.isFinite(limitParam)
        ? Math.min(Math.max(Math.floor(limitParam), 1), 500)
        : 100;

      const payments = listAgentToAgentPayments(db, {
        agentIdentityId,
        role,
        limit,
      });
      res.json({ payments: payments.map(publicView) });
    } catch (err) {
      next(err);
    }
  });

  // GET /agents/payments/:id — fetch a single A2A payment by id.
  router.get("/agents/payments/:id", (req, res, next) => {
    try {
      const id = req.params.id ?? "";
      const payment = findAgentToAgentPayment(db, id);
      if (!payment) {
        throw HttpError.notFound(`agent payment ${id} not found`);
      }
      res.json({ payment: publicView(payment) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
