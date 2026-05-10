import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  AGENT_HEADER,
  encodeAgentProof,
  signAgentProof,
  type AgentProof,
  type AgentProvider,
} from "../src/lib/agent-identity.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in agent-identity tests");
  },
} as unknown as SolanaService;

interface Server {
  url: string;
  close: () => Promise<void>;
}

async function startApp(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

interface AgentKey {
  publicKey: string;
  privateKey: KeyObject;
}

function makeKey(): AgentKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  return {
    publicKey: bs58.encode(spki.subarray(spki.length - 32)),
    privateKey,
  };
}

function makeProofHeader(
  args: {
    provider: AgentProvider;
    agentId: string;
    key: AgentKey;
    nonce?: string;
    timestamp?: number;
    publicKeyOverride?: string;
  },
): { proof: AgentProof; header: string } {
  const proof = signAgentProof({
    provider: args.provider,
    agentId: args.agentId,
    publicKey: args.publicKeyOverride ?? args.key.publicKey,
    privateKey: args.key.privateKey,
    nonce: args.nonce,
    timestamp: args.timestamp,
  });
  return { proof, header: encodeAgentProof(proof) };
}

describe("/agents/identity — REST", () => {
  let db: Db;
  let server: Server;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    server = await startApp(createApp({ db, solana: dummySolana }));
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("publishes the proof spec at /agents/identity/spec", async () => {
    const res = await fetch(`${server.url}/agents/identity/spec`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      header: string;
      schema: string;
      supportedProviders: string[];
      signatureAlgorithm: string;
    };
    expect(body.header).toBe(AGENT_HEADER);
    expect(body.signatureAlgorithm).toBe("ed25519");
    expect(body.supportedProviders).toContain("anthropic");
    expect(body.supportedProviders).toContain("openai");
  });

  it("registers a fresh agent identity binding", async () => {
    const key = makeKey();
    const { header } = makeProofHeader({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      key,
    });
    const res = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: key.publicKey,
        displayName: "Claude Opus 4.7",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      identity: { provider: string; agentId: string; publicKey: string };
      alreadyRegistered: boolean;
    };
    expect(body.identity.provider).toBe("anthropic");
    expect(body.identity.agentId).toBe("claude-opus-4-7");
    expect(body.identity.publicKey).toBe(key.publicKey);
    expect(body.alreadyRegistered).toBe(false);
  });

  it("rejects registration when the proof header is missing", async () => {
    const key = makeKey();
    const res = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: key.publicKey,
      }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects registration when the proof body and header diverge (spoof)", async () => {
    const victim = makeKey();
    const attacker = makeKey();
    // Attacker signs with their own key but claims the victim's publicKey
    // in the request body. The route MUST reject because the body publicKey
    // doesn't match the proof publicKey.
    const { header } = makeProofHeader({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      key: attacker,
    });
    const res = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: victim.publicKey,
      }),
    });
    expect(res.status).toBe(400);
  });

  it("returns idempotently when re-registering with the same key + a fresh nonce", async () => {
    const key = makeKey();
    const first = makeProofHeader({
      provider: "openai",
      agentId: "gpt-4o",
      key,
    });
    const r1 = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: first.header,
      },
      body: JSON.stringify({
        provider: "openai",
        agentId: "gpt-4o",
        publicKey: key.publicKey,
      }),
    });
    expect(r1.status).toBe(201);

    const second = makeProofHeader({
      provider: "openai",
      agentId: "gpt-4o",
      key,
    });
    const r2 = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: second.header,
      },
      body: JSON.stringify({
        provider: "openai",
        agentId: "gpt-4o",
        publicKey: key.publicKey,
      }),
    });
    expect(r2.status).toBe(200);
    const body = (await r2.json()) as { alreadyRegistered: boolean };
    expect(body.alreadyRegistered).toBe(true);
  });

  it("conflicts when a different key tries to claim a taken (provider, agentId)", async () => {
    const owner = makeKey();
    const intruder = makeKey();
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "anthropic",
          agentId: "claude-opus-4-7",
          key: owner,
        }).header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: owner.publicKey,
      }),
    });

    const res = await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "anthropic",
          agentId: "claude-opus-4-7",
          key: intruder,
        }).header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: intruder.publicKey,
      }),
    });
    expect(res.status).toBe(409);
  });

  it("looks up a binding via GET", async () => {
    const key = makeKey();
    const { header } = makeProofHeader({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      key,
    });
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: key.publicKey,
      }),
    });

    const lookup = await fetch(
      `${server.url}/agents/identity?provider=anthropic&agentId=claude-opus-4-7`,
    );
    expect(lookup.status).toBe(200);
    const body = (await lookup.json()) as {
      identity: { publicKey: string; status: string };
    };
    expect(body.identity.publicKey).toBe(key.publicKey);
    expect(body.identity.status).toBe("active");
  });

  it("returns 404 for an unknown binding lookup", async () => {
    const res = await fetch(
      `${server.url}/agents/identity?provider=openai&agentId=ghost`,
    );
    expect(res.status).toBe(404);
  });

  it("verifies a valid proof against the stored binding", async () => {
    const key = makeKey();
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "openai",
          agentId: "gpt-4o",
          key,
        }).header,
      },
      body: JSON.stringify({
        provider: "openai",
        agentId: "gpt-4o",
        publicKey: key.publicKey,
      }),
    });

    const verify = await fetch(`${server.url}/agents/identity/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "openai",
          agentId: "gpt-4o",
          key,
        }).header,
      },
    });
    expect(verify.status).toBe(200);
    const body = (await verify.json()) as {
      verified: boolean;
      identity: { publicKey: string };
    };
    expect(body.verified).toBe(true);
    expect(body.identity.publicKey).toBe(key.publicKey);
  });

  it("blocks a spoofed verification — wrong key for a registered agentId", async () => {
    const owner = makeKey();
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "anthropic",
          agentId: "claude-opus-4-7",
          key: owner,
        }).header,
      },
      body: JSON.stringify({
        provider: "anthropic",
        agentId: "claude-opus-4-7",
        publicKey: owner.publicKey,
      }),
    });

    const attacker = makeKey();
    // Attacker signs a perfectly-valid-looking proof with their own key but
    // claiming to be claude-opus-4-7. The signature verifies cryptographically,
    // but the binding lookup must reject because the publicKey doesn't match.
    const { header: attackerHeader } = makeProofHeader({
      provider: "anthropic",
      agentId: "claude-opus-4-7",
      key: attacker,
    });
    const res = await fetch(`${server.url}/agents/identity/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: attackerHeader,
      },
    });
    expect(res.status).toBe(403);
  });

  it("blocks proof replay — the same nonce cannot verify twice", async () => {
    const key = makeKey();
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "openai",
          agentId: "gpt-4o",
          key,
        }).header,
      },
      body: JSON.stringify({
        provider: "openai",
        agentId: "gpt-4o",
        publicKey: key.publicKey,
      }),
    });

    const replayProof = makeProofHeader({
      provider: "openai",
      agentId: "gpt-4o",
      key,
    });
    const r1 = await fetch(`${server.url}/agents/identity/verify`, {
      method: "POST",
      headers: { [AGENT_HEADER]: replayProof.header },
    });
    expect(r1.status).toBe(200);

    const r2 = await fetch(`${server.url}/agents/identity/verify`, {
      method: "POST",
      headers: { [AGENT_HEADER]: replayProof.header },
    });
    expect(r2.status).toBe(401);
  });

  it("blocks stale proofs at /verify", async () => {
    const key = makeKey();
    await fetch(`${server.url}/agents/identity`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: makeProofHeader({
          provider: "openai",
          agentId: "gpt-4o",
          key,
        }).header,
      },
      body: JSON.stringify({
        provider: "openai",
        agentId: "gpt-4o",
        publicKey: key.publicKey,
      }),
    });

    const stale = makeProofHeader({
      provider: "openai",
      agentId: "gpt-4o",
      key,
      timestamp: Date.now() - 24 * 60 * 60 * 1000,
    });
    const res = await fetch(`${server.url}/agents/identity/verify`, {
      method: "POST",
      headers: { [AGENT_HEADER]: stale.header },
    });
    expect(res.status).toBe(401);
  });
});
