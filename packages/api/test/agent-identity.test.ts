import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import bs58 from "bs58";
import {
  AGENT_HEADER,
  AgentIdentityError,
  PROOF_FRESHNESS_MS,
  PROOF_SCHEMA_VERSION,
  buildCanonicalMessage,
  decodeAgentProof,
  encodeAgentProof,
  generateNonce,
  signAgentProof,
  verifyProofSignature,
} from "../src/lib/agent-identity.js";

function makeKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

describe("agent-identity / lib", () => {
  it("exposes a stable wire header name", () => {
    expect(AGENT_HEADER).toBe("x-zettapay-agent");
    expect(PROOF_SCHEMA_VERSION).toBe("ZETTAPAY-AGENT-PROOF-V1");
  });

  it("builds a canonical message with deterministic line ordering", () => {
    const msg = buildCanonicalMessage({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      publicKey: "PK",
      nonce: "N",
      timestamp: 1700000000000,
    });
    expect(msg.toString("utf8")).toBe(
      [
        PROOF_SCHEMA_VERSION,
        "provider=anthropic",
        "agentId=claude-opus-4-7",
        "publicKey=PK",
        "nonce=N",
        "timestamp=1700000000000",
      ].join("\n"),
    );
  });

  it("signs and verifies a fresh proof end-to-end", () => {
    const { publicKey, privateKey } = makeKeypair();
    const proof = signAgentProof({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      publicKey,
      privateKey,
    });
    expect(proof.nonce.length).toBeGreaterThanOrEqual(16);
    expect(() => verifyProofSignature(proof)).not.toThrow();
  });

  it("rejects a proof signed by a different private key (spoof)", () => {
    const victim = makeKeypair();
    const attacker = makeKeypair();
    const proof = signAgentProof({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      publicKey: victim.publicKey,
      privateKey: attacker.privateKey,
    });
    expect(() => verifyProofSignature(proof)).toThrowError(
      AgentIdentityError,
    );
  });

  it("rejects a tampered field", () => {
    const { publicKey, privateKey } = makeKeypair();
    const proof = signAgentProof({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      publicKey,
      privateKey,
    });
    const tampered = { ...proof, agentId: "gpt-4o" };
    expect(() => verifyProofSignature(tampered)).toThrow(/signature/i);
  });

  it("rejects stale proofs older than the freshness window", () => {
    const { publicKey, privateKey } = makeKeypair();
    const proof = signAgentProof({
      provider: "openai",
      agentId: "gpt-4o",
      publicKey,
      privateKey,
      timestamp: 1000,
    });
    const now = 1000 + PROOF_FRESHNESS_MS + 1;
    expect(() => verifyProofSignature(proof, { now })).toThrow(/older/);
  });

  it("rejects future-dated proofs", () => {
    const { publicKey, privateKey } = makeKeypair();
    const future = Date.now() + PROOF_FRESHNESS_MS + 60_000;
    const proof = signAgentProof({
      provider: "openai",
      agentId: "gpt-4o",
      publicKey,
      privateKey,
      timestamp: future,
    });
    expect(() => verifyProofSignature(proof)).toThrow(/future/);
  });

  it("encodes and decodes proofs through the wire format", () => {
    const { publicKey, privateKey } = makeKeypair();
    const proof = signAgentProof({
      provider: "google",
      agentId: "gemini-2.5-pro",
      publicKey,
      privateKey,
    });
    const wire = encodeAgentProof(proof);
    const decoded = decodeAgentProof(wire);
    expect(decoded).toEqual(proof);
    expect(() => verifyProofSignature(decoded)).not.toThrow();
  });

  it("rejects unsupported providers", () => {
    expect(() =>
      decodeAgentProof(
        Buffer.from(
          JSON.stringify({
            provider: "rogue-llm",
            agentId: "x",
            publicKey: "PK",
            nonce: "0123456789abcdef",
            timestamp: Date.now(),
            signature: "sig",
          }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toThrow(/provider/);
  });

  it("rejects weak nonces below the entropy floor", () => {
    expect(() =>
      decodeAgentProof(
        Buffer.from(
          JSON.stringify({
            provider: "anthropic",
            agentId: "claude",
            publicKey: "PK",
            nonce: "short",
            timestamp: Date.now(),
            signature: "sig",
          }),
          "utf8",
        ).toString("base64url"),
      ),
    ).toThrow(/nonce/);
  });

  it("rejects malformed base64url envelopes", () => {
    expect(() => decodeAgentProof("@@@not base64@@@")).toThrowError(
      AgentIdentityError,
    );
  });

  it("generateNonce produces unique high-entropy strings", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(16);
  });
});
