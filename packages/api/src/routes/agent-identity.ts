import { Router } from "express";
import { PublicKey } from "@solana/web3.js";
import type { Database as Db } from "better-sqlite3";
import { HttpError } from "../lib/errors.js";
import {
  optionalString,
  requireString,
} from "../lib/validate.js";
import {
  AGENT_HEADER,
  PROOF_FRESHNESS_MS,
  PROOF_SCHEMA_VERSION,
  SUPPORTED_PROVIDERS,
  isSupportedProvider,
  type AgentProvider,
} from "../lib/agent-identity.js";
import {
  AgentIdentityServiceError,
  registerAgentIdentity,
  verifyAgentProofHeader,
} from "../services/agent-identity.js";
import {
  findAgentIdentityByProviderAgent,
  setAgentIdentityPayoutWallet,
} from "../db/agent_identities.js";

function publicView(
  identity: ReturnType<typeof findAgentIdentityByProviderAgent>,
) {
  if (!identity) return null;
  return {
    id: identity.id,
    provider: identity.provider,
    agentId: identity.agentId,
    publicKey: identity.publicKey,
    displayName: identity.displayName,
    payoutWallet: identity.payoutWallet,
    status: identity.status,
    registeredAt: identity.registeredAt,
  };
}

function validatePayoutWallet(value: string): string {
  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw HttpError.badRequest(
      "payoutWallet must be a valid base58-encoded Solana public key",
    );
  }
}

function asHttpError(err: unknown): HttpError {
  if (err instanceof AgentIdentityServiceError) {
    if (err.status === 401) return HttpError.unauthorized(err.message);
    if (err.status === 403) {
      return new HttpError(403, "unauthorized", err.message);
    }
    if (err.status === 404) return HttpError.notFound(err.message);
    if (err.status === 409) return HttpError.conflict(err.message);
    return HttpError.badRequest(err.message);
  }
  if (err instanceof HttpError) return err;
  throw err;
}

export function agentIdentityRouter(db: Db): Router {
  const router = Router();

  router.get("/agents/identity/spec", (_req, res) => {
    res.json({
      header: AGENT_HEADER,
      schema: PROOF_SCHEMA_VERSION,
      supportedProviders: SUPPORTED_PROVIDERS,
      proofFreshnessMs: PROOF_FRESHNESS_MS,
      canonicalMessage: [
        PROOF_SCHEMA_VERSION,
        "provider=<provider>",
        "agentId=<agentId>",
        "publicKey=<base58 ed25519 pubkey>",
        "nonce=<>=16 chars>",
        "timestamp=<unix ms>",
      ].join("\n"),
      signatureAlgorithm: "ed25519",
      headerEncoding: "base64url(json)",
    });
  });

  router.post("/agents/identity", (req, res, next) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provider = requireString(body, "provider", { maxLength: 32 });
      if (!isSupportedProvider(provider)) {
        throw HttpError.badRequest(
          `Field "provider" must be one of: ${SUPPORTED_PROVIDERS.join(", ")}`,
        );
      }
      const agentId = requireString(body, "agentId", { maxLength: 128 });
      const publicKey = requireString(body, "publicKey", { maxLength: 128 });
      const displayName = optionalString(body, "displayName", {
        maxLength: 120,
      });
      const ownerEmail = optionalString(body, "ownerEmail", { maxLength: 254 });
      const payoutWalletRaw = optionalString(body, "payoutWallet", {
        maxLength: 64,
      });
      const payoutWallet = payoutWalletRaw
        ? validatePayoutWallet(payoutWalletRaw)
        : null;

      const proofHeader = req.header(AGENT_HEADER);
      if (!proofHeader) {
        throw HttpError.unauthorized(
          `"${AGENT_HEADER}" header is required — sign a proof with the registering key`,
        );
      }

      try {
        const result = registerAgentIdentity(db, {
          provider: provider as AgentProvider,
          agentId,
          publicKey,
          displayName,
          ownerEmail,
          payoutWallet,
          proofHeader,
        });
        let identity = result.identity;
        // If the agent already existed without a payout wallet and the
        // caller proved ownership, persist the wallet now. Existing wallets
        // are not overwritten silently — callers must hit the dedicated
        // PUT /agents/identity/payout-wallet endpoint to rotate.
        if (
          payoutWallet &&
          result.alreadyRegistered &&
          !identity.payoutWallet
        ) {
          const updated = setAgentIdentityPayoutWallet(
            db,
            identity.id,
            payoutWallet,
          );
          if (updated) identity = updated;
        }
        res
          .status(result.alreadyRegistered ? 200 : 201)
          .json({
            identity: publicView(identity),
            alreadyRegistered: result.alreadyRegistered,
          });
      } catch (err) {
        throw asHttpError(err);
      }
    } catch (err) {
      next(err);
    }
  });

  router.get("/agents/identity", (req, res, next) => {
    try {
      const provider =
        typeof req.query.provider === "string" ? req.query.provider : "";
      const agentId =
        typeof req.query.agentId === "string" ? req.query.agentId : "";
      if (!provider || !agentId) {
        throw HttpError.badRequest(
          'Query params "provider" and "agentId" are required',
        );
      }
      const identity = findAgentIdentityByProviderAgent(db, provider, agentId);
      if (!identity) {
        throw HttpError.notFound(
          `no agent identity bound to (${provider}, ${agentId})`,
        );
      }
      res.json({ identity: publicView(identity) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/agents/identity/verify", (req, res, next) => {
    try {
      const proofHeader = req.header(AGENT_HEADER);
      if (!proofHeader) {
        throw HttpError.unauthorized(`"${AGENT_HEADER}" header is required`);
      }
      try {
        const verified = verifyAgentProofHeader(db, proofHeader);
        res.json({
          verified: true,
          identity: publicView(verified.identity),
          verifiedAt: new Date().toISOString(),
        });
      } catch (err) {
        throw asHttpError(err);
      }
    } catch (err) {
      next(err);
    }
  });

  // Z20.4: rotate the payout wallet for an existing identity. Requires a
  // fresh signed proof from the same key — the (proof, target) pair is
  // matched to defeat substitution attacks.
  router.put("/agents/identity/payout-wallet", (req, res, next) => {
    try {
      const proofHeader = req.header(AGENT_HEADER);
      if (!proofHeader) {
        throw HttpError.unauthorized(
          `"${AGENT_HEADER}" header is required to rotate payout wallet`,
        );
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const payoutWalletRaw = requireString(body, "payoutWallet", {
        maxLength: 64,
      });
      const payoutWallet = validatePayoutWallet(payoutWalletRaw);

      try {
        const verified = verifyAgentProofHeader(db, proofHeader);
        const updated = setAgentIdentityPayoutWallet(
          db,
          verified.identity.id,
          payoutWallet,
        );
        if (!updated) {
          throw HttpError.notFound(
            `agent identity ${verified.identity.id} not found`,
          );
        }
        res.json({ identity: publicView(updated) });
      } catch (err) {
        throw asHttpError(err);
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
