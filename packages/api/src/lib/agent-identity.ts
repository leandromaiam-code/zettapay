import {
  createPublicKey,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import bs58 from "bs58";

/**
 * Wire header that carries an agent's signed identity proof. Companion to the
 * x402 payment header: x402 proves *the wallet authorized this transaction*,
 * AGENT_HEADER proves *this is the AI agent that the merchant thinks it is*.
 * The two together close the spoofing gap on the agent → merchant leg.
 */
export const AGENT_HEADER = "x-zettapay-agent";

export const PROOF_SCHEMA_VERSION = "ZETTAPAY-AGENT-PROOF-V1";
export const PROOF_FRESHNESS_MS = 5 * 60_000;

export const SUPPORTED_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "xai",
  "meta",
  "mistral",
  "cohere",
  "deepseek",
  "custom",
] as const;
export type AgentProvider = (typeof SUPPORTED_PROVIDERS)[number];

const ED25519_PUBKEY_LENGTH = 32;
const ED25519_SIG_LENGTH = 64;
const MIN_NONCE_BYTES = 16;
const MAX_AGENT_ID_LENGTH = 128;
const MAX_HEADER_BYTES = 4096;
const ED25519_DER_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type AgentIdentityErrorCode =
  | "missing_header"
  | "invalid_encoding"
  | "malformed_proof"
  | "unsupported_version"
  | "unsupported_provider"
  | "invalid_public_key"
  | "invalid_signature"
  | "stale_proof"
  | "future_proof"
  | "weak_nonce";

export class AgentIdentityError extends Error {
  constructor(
    public readonly code: AgentIdentityErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentIdentityError";
  }
}

export interface AgentProof {
  provider: AgentProvider;
  agentId: string;
  publicKey: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

export interface SignProofInput {
  provider: AgentProvider;
  agentId: string;
  publicKey: string;
  privateKey: KeyObject;
  nonce?: string;
  timestamp?: number;
}

export function isSupportedProvider(value: unknown): value is AgentProvider {
  return (
    typeof value === "string" &&
    (SUPPORTED_PROVIDERS as readonly string[]).includes(value)
  );
}

export function normalizeAgentId(value: string): string {
  return value.trim();
}

export function buildCanonicalMessage(
  proof: Omit<AgentProof, "signature">,
): Buffer {
  const lines = [
    PROOF_SCHEMA_VERSION,
    `provider=${proof.provider}`,
    `agentId=${proof.agentId}`,
    `publicKey=${proof.publicKey}`,
    `nonce=${proof.nonce}`,
    `timestamp=${proof.timestamp}`,
  ];
  return Buffer.from(lines.join("\n"), "utf8");
}

export function generateNonce(byteLength = MIN_NONCE_BYTES): string {
  return randomBytes(byteLength).toString("base64url");
}

function decodePublicKey(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new AgentIdentityError(
      "invalid_public_key",
      "publicKey must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_PUBKEY_LENGTH) {
    throw new AgentIdentityError(
      "invalid_public_key",
      `publicKey must decode to ${ED25519_PUBKEY_LENGTH} bytes`,
    );
  }
  return raw;
}

function decodeSignature(value: string): Buffer {
  let raw: Buffer;
  try {
    raw = Buffer.from(bs58.decode(value));
  } catch {
    throw new AgentIdentityError(
      "invalid_signature",
      "signature must be base58-encoded",
    );
  }
  if (raw.length !== ED25519_SIG_LENGTH) {
    throw new AgentIdentityError(
      "invalid_signature",
      `signature must decode to ${ED25519_SIG_LENGTH} bytes`,
    );
  }
  return raw;
}

function ed25519Verify(
  pubKey: Buffer,
  message: Buffer,
  signature: Buffer,
): boolean {
  try {
    const der = Buffer.concat([ED25519_DER_PREFIX, pubKey]);
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

export function signAgentProof(input: SignProofInput): AgentProof {
  if (!isSupportedProvider(input.provider)) {
    throw new AgentIdentityError(
      "unsupported_provider",
      `provider "${String(input.provider)}" is not supported`,
    );
  }
  const agentId = normalizeAgentId(input.agentId);
  if (agentId.length === 0 || agentId.length > MAX_AGENT_ID_LENGTH) {
    throw new AgentIdentityError(
      "malformed_proof",
      `agentId must be 1..${MAX_AGENT_ID_LENGTH} chars`,
    );
  }
  decodePublicKey(input.publicKey);
  const nonce = input.nonce ?? generateNonce();
  if (nonce.length < 16) {
    throw new AgentIdentityError(
      "weak_nonce",
      "nonce must be at least 16 chars (>= 96 bits of entropy)",
    );
  }
  const timestamp = input.timestamp ?? Date.now();
  const message = buildCanonicalMessage({
    provider: input.provider,
    agentId,
    publicKey: input.publicKey,
    nonce,
    timestamp,
  });
  const sig = cryptoSign(null, message, input.privateKey);
  return {
    provider: input.provider,
    agentId,
    publicKey: input.publicKey,
    nonce,
    timestamp,
    signature: bs58.encode(sig),
  };
}

export function encodeAgentProof(proof: AgentProof): string {
  return Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
}

export function decodeAgentProof(headerValue: string): AgentProof {
  if (typeof headerValue !== "string" || headerValue.trim().length === 0) {
    throw new AgentIdentityError("missing_header", "header value is empty");
  }
  if (Buffer.byteLength(headerValue, "utf8") > MAX_HEADER_BYTES) {
    throw new AgentIdentityError(
      "invalid_encoding",
      `header exceeds ${MAX_HEADER_BYTES} bytes`,
    );
  }
  let json: string;
  try {
    json = Buffer.from(headerValue.trim(), "base64url").toString("utf8");
  } catch {
    throw new AgentIdentityError(
      "invalid_encoding",
      "header must be base64url-encoded JSON",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AgentIdentityError(
      "invalid_encoding",
      "header must decode to a JSON object",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AgentIdentityError(
      "malformed_proof",
      "proof must be a JSON object",
    );
  }
  const obj = parsed as Record<string, unknown>;
  const provider = obj.provider;
  const agentId = obj.agentId;
  const publicKey = obj.publicKey;
  const nonce = obj.nonce;
  const timestamp = obj.timestamp;
  const signature = obj.signature;

  if (!isSupportedProvider(provider)) {
    throw new AgentIdentityError(
      "unsupported_provider",
      `provider "${String(provider)}" is not supported`,
    );
  }
  if (typeof agentId !== "string" || normalizeAgentId(agentId).length === 0) {
    throw new AgentIdentityError(
      "malformed_proof",
      "agentId must be a non-empty string",
    );
  }
  if (normalizeAgentId(agentId).length > MAX_AGENT_ID_LENGTH) {
    throw new AgentIdentityError(
      "malformed_proof",
      `agentId exceeds ${MAX_AGENT_ID_LENGTH} chars`,
    );
  }
  if (typeof publicKey !== "string" || publicKey.length === 0) {
    throw new AgentIdentityError(
      "invalid_public_key",
      "publicKey must be a non-empty string",
    );
  }
  if (typeof nonce !== "string" || nonce.length < 16) {
    throw new AgentIdentityError(
      "weak_nonce",
      "nonce must be a string with at least 16 chars",
    );
  }
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
    throw new AgentIdentityError(
      "malformed_proof",
      "timestamp must be a finite number (unix ms)",
    );
  }
  if (typeof signature !== "string" || signature.length === 0) {
    throw new AgentIdentityError(
      "invalid_signature",
      "signature must be a non-empty string",
    );
  }

  return {
    provider,
    agentId: normalizeAgentId(agentId),
    publicKey,
    nonce,
    timestamp,
    signature,
  };
}

export interface VerifyOptions {
  now?: number;
  maxClockSkewMs?: number;
}

/**
 * Verify the cryptographic shape of a proof: signature is valid for the
 * embedded public key, the timestamp is within the freshness window, and the
 * nonce meets the entropy floor. This does NOT check whether the
 * (provider, agentId) tuple is bound to that public key — DB binding is the
 * caller's responsibility.
 */
export function verifyProofSignature(
  proof: AgentProof,
  options: VerifyOptions = {},
): void {
  const now = options.now ?? Date.now();
  const skew = options.maxClockSkewMs ?? PROOF_FRESHNESS_MS;
  const age = now - proof.timestamp;
  if (age > skew) {
    throw new AgentIdentityError(
      "stale_proof",
      `proof is older than ${skew}ms (age=${age}ms)`,
    );
  }
  if (age < -skew) {
    throw new AgentIdentityError(
      "future_proof",
      "proof timestamp is too far in the future",
    );
  }
  const pubKey = decodePublicKey(proof.publicKey);
  const sig = decodeSignature(proof.signature);
  const message = buildCanonicalMessage(proof);
  if (!ed25519Verify(pubKey, message, sig)) {
    throw new AgentIdentityError(
      "invalid_signature",
      "proof signature did not verify against the embedded public key",
    );
  }
}
