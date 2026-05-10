import type { Database as Db } from "better-sqlite3";
import {
  AgentIdentityError,
  decodeAgentProof,
  isSupportedProvider,
  normalizeAgentId,
  verifyProofSignature,
  type AgentProof,
  type AgentProvider,
} from "../lib/agent-identity.js";
import {
  findAgentIdentityByProviderAgent,
  findAgentIdentityByPublicKey,
  insertAgentIdentity,
  recordAgentNonce,
  setAgentIdentityStatus,
  type AgentIdentity,
} from "../db/agent_identities.js";
import { newId } from "../lib/id.js";

const MAX_DISPLAY_NAME = 120;
const MAX_OWNER_EMAIL = 254;

export interface RegisterAgentInput {
  provider: AgentProvider;
  agentId: string;
  publicKey: string;
  displayName?: string | null;
  ownerEmail?: string | null;
  /** Encoded proof header value — proves the caller controls publicKey. */
  proofHeader: string;
}

export interface RegisterAgentResult {
  identity: AgentIdentity;
  /** True when the binding already existed and was returned idempotently. */
  alreadyRegistered: boolean;
}

export class AgentIdentityServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AgentIdentityServiceError";
  }
}

function asServiceError(err: unknown): AgentIdentityServiceError {
  if (err instanceof AgentIdentityError) {
    const status =
      err.code === "stale_proof" ||
      err.code === "future_proof" ||
      err.code === "invalid_signature"
        ? 401
        : 400;
    return new AgentIdentityServiceError(status, err.code, err.message);
  }
  if (err instanceof AgentIdentityServiceError) return err;
  throw err;
}

/**
 * Register a (provider, agentId) → publicKey binding. The caller MUST present
 * a fresh signed proof in the AGENT_HEADER, demonstrating control of the
 * private key matching `publicKey`. The (provider, agentId) tuple and the
 * publicKey are both unique — duplicate registration with the same triple
 * returns the existing record idempotently; mismatches reject with 409.
 */
export function registerAgentIdentity(
  db: Db,
  input: RegisterAgentInput,
): RegisterAgentResult {
  if (!isSupportedProvider(input.provider)) {
    throw new AgentIdentityServiceError(
      400,
      "unsupported_provider",
      `provider "${String(input.provider)}" is not supported`,
    );
  }
  const agentId = normalizeAgentId(input.agentId);
  if (agentId.length === 0) {
    throw new AgentIdentityServiceError(
      400,
      "validation_error",
      "agentId must be a non-empty string",
    );
  }
  if (input.displayName && input.displayName.length > MAX_DISPLAY_NAME) {
    throw new AgentIdentityServiceError(
      400,
      "validation_error",
      `displayName exceeds ${MAX_DISPLAY_NAME} chars`,
    );
  }
  if (input.ownerEmail && input.ownerEmail.length > MAX_OWNER_EMAIL) {
    throw new AgentIdentityServiceError(
      400,
      "validation_error",
      `ownerEmail exceeds ${MAX_OWNER_EMAIL} chars`,
    );
  }

  let proof: AgentProof;
  try {
    proof = decodeAgentProof(input.proofHeader);
    verifyProofSignature(proof);
  } catch (err) {
    throw asServiceError(err);
  }

  if (
    proof.provider !== input.provider ||
    proof.agentId !== agentId ||
    proof.publicKey !== input.publicKey
  ) {
    throw new AgentIdentityServiceError(
      400,
      "proof_body_mismatch",
      "proof header does not match the registration body",
    );
  }

  const existingByPair = findAgentIdentityByProviderAgent(
    db,
    input.provider,
    agentId,
  );
  if (existingByPair) {
    if (existingByPair.publicKey !== input.publicKey) {
      throw new AgentIdentityServiceError(
        409,
        "agent_id_taken",
        `(${input.provider}, ${agentId}) is bound to a different public key — rotate via revoke first`,
      );
    }
    if (existingByPair.status !== "active") {
      throw new AgentIdentityServiceError(
        409,
        "agent_id_revoked",
        "this agent identity is revoked",
      );
    }
    if (!recordAgentNonce(db, existingByPair.id, proof.nonce)) {
      throw new AgentIdentityServiceError(
        401,
        "replay_detected",
        "proof nonce has already been used",
      );
    }
    return { identity: existingByPair, alreadyRegistered: true };
  }

  const existingByKey = findAgentIdentityByPublicKey(db, input.publicKey);
  if (existingByKey) {
    throw new AgentIdentityServiceError(
      409,
      "public_key_taken",
      "this public key is already bound to another agent identity",
    );
  }

  const identity = insertAgentIdentity(db, {
    id: newId("agt"),
    provider: input.provider,
    agentId,
    publicKey: input.publicKey,
    displayName: input.displayName ?? null,
    ownerEmail: input.ownerEmail ?? null,
    status: "active",
  });
  // Mark the registration nonce as used so the same proof can't be replayed.
  recordAgentNonce(db, identity.id, proof.nonce);
  return { identity, alreadyRegistered: false };
}

export interface VerifiedAgent {
  identity: AgentIdentity;
  proof: AgentProof;
}

/**
 * Verify a wire-encoded proof against the stored binding and consume the
 * nonce to prevent replay. Throws AgentIdentityServiceError on any failure.
 */
export function verifyAgentProofHeader(
  db: Db,
  proofHeader: string,
): VerifiedAgent {
  let proof: AgentProof;
  try {
    proof = decodeAgentProof(proofHeader);
    verifyProofSignature(proof);
  } catch (err) {
    throw asServiceError(err);
  }
  const identity = findAgentIdentityByProviderAgent(
    db,
    proof.provider,
    proof.agentId,
  );
  if (!identity) {
    throw new AgentIdentityServiceError(
      404,
      "agent_not_registered",
      `no binding found for (${proof.provider}, ${proof.agentId})`,
    );
  }
  if (identity.status !== "active") {
    throw new AgentIdentityServiceError(
      403,
      "agent_revoked",
      "agent identity is revoked",
    );
  }
  if (identity.publicKey !== proof.publicKey) {
    // Spoof attempt: caller signed with a key that does not match the binding.
    throw new AgentIdentityServiceError(
      403,
      "spoofed_identity",
      "proof public key does not match the registered binding for this agent",
    );
  }
  if (!recordAgentNonce(db, identity.id, proof.nonce)) {
    throw new AgentIdentityServiceError(
      401,
      "replay_detected",
      "proof nonce has already been used for this agent identity",
    );
  }
  return { identity, proof };
}

export function revokeAgentIdentityById(
  db: Db,
  id: string,
): AgentIdentity | null {
  return setAgentIdentityStatus(db, id, "revoked");
}
