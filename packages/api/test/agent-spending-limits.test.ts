import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  findAgentSpendingLimit,
  setAgentSpendingLimitFrozen,
  upsertAgentSpendingLimit,
} from "../src/db/agent_spending_limits.js";
import { enforceAgentSpendingLimits } from "../src/services/agent-spending-limits.js";
import { findAgentIdentityById, insertAgentIdentity } from "../src/db/agent_identities.js";
import { insertPayment, markPaymentCompleted } from "../src/db/payments.js";
import { HttpError } from "../src/lib/errors.js";
import { newId } from "../src/lib/id.js";
import {
  AGENT_HEADER,
  encodeAgentProof,
  signAgentProof,
} from "../src/lib/agent-identity.js";
import type { SolanaService } from "../src/services/solana.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: express.Express): Promise<RunningServer> {
  return new Promise((resolve) => {
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

function makeFakeSolana(payerKp: Keypair): SolanaService {
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(
      async (params: { recipientOwner: PublicKey; amount: number }) => ({
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}_${Math.random()}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
        currency: "USDC",
        mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }),
    ),
  } as unknown as SolanaService;
}

function makeAgentKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

function buildAgentHeader(input: {
  provider: "anthropic";
  agentId: string;
  publicKey: string;
  privateKey: ReturnType<typeof makeAgentKeypair>["privateKey"];
}): string {
  const proof = signAgentProof({
    provider: input.provider,
    agentId: input.agentId,
    publicKey: input.publicKey,
    privateKey: input.privateKey,
  });
  return encodeAgentProof(proof);
}

describe("enforceAgentSpendingLimits service", () => {
  let db: Db;
  let merchantId: string;
  let agentId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Limits Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `lim-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const identity = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: `agent-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
    });
    agentId = identity.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("is permissive when no limit row exists for the agent", () => {
    const telemetry = enforceAgentSpendingLimits(db, {
      merchantId,
      agentIdentityId: agentId,
      amount: 100,
    });
    expect(telemetry.maxPerRequest).toBeNull();
    expect(telemetry.dailyCap).toBeNull();
    expect(telemetry.frozen).toBe(false);
  });

  it("rejects with 403 when the agent is frozen", () => {
    setAgentSpendingLimitFrozen(db, merchantId, agentId, true);
    let caught: HttpError | null = null;
    try {
      enforceAgentSpendingLimits(db, {
        merchantId,
        agentIdentityId: agentId,
        amount: 1,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(403);
    expect(caught?.code).toBe("unauthorized");
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("agent_spending_limits:frozen");
  });

  it("rejects amounts above max_per_request with 429", () => {
    upsertAgentSpendingLimit(db, {
      merchantId,
      agentIdentityId: agentId,
      maxPerRequest: 10,
      dailyCap: null,
    });
    let caught: HttpError | null = null;
    try {
      enforceAgentSpendingLimits(db, {
        merchantId,
        agentIdentityId: agentId,
        amount: 25,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught?.status).toBe(429);
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("agent_spending_limits:max_per_request");
  });

  it("rejects when daily_cap would be exceeded by the new payment", () => {
    upsertAgentSpendingLimit(db, {
      merchantId,
      agentIdentityId: agentId,
      maxPerRequest: null,
      dailyCap: 100,
    });
    // Pre-fill 80 USDC of completed spend by this agent.
    for (let i = 0; i < 4; i += 1) {
      const payId = `pay_dc_${i}`;
      insertPayment(db, {
        id: payId,
        merchantId,
        amountUsdc: 20,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        metadata: null,
        agentIdentityId: agentId,
      });
      markPaymentCompleted(db, payId, `sig_dc_${i}`);
    }
    let caught: HttpError | null = null;
    try {
      enforceAgentSpendingLimits(db, {
        merchantId,
        agentIdentityId: agentId,
        amount: 25,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught?.status).toBe(429);
    const details = caught?.details as { scope: string };
    expect(details.scope).toBe("agent_spending_limits:daily_cap");
  });

  it("does not count payments tagged to other agents", () => {
    upsertAgentSpendingLimit(db, {
      merchantId,
      agentIdentityId: agentId,
      maxPerRequest: null,
      dailyCap: 50,
    });
    const otherAgent = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "openai",
      agentId: `other-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
    });
    // 200 USDC of spend by the *other* agent must not consume this agent's budget.
    const payId = `pay_other_${Date.now()}`;
    insertPayment(db, {
      id: payId,
      merchantId,
      amountUsdc: 200,
      payerWallet: Keypair.generate().publicKey.toBase58(),
      metadata: null,
      agentIdentityId: otherAgent.id,
    });
    markPaymentCompleted(db, payId, `sig_${payId}`);
    expect(() =>
      enforceAgentSpendingLimits(db, {
        merchantId,
        agentIdentityId: agentId,
        amount: 25,
      }),
    ).not.toThrow();
  });

  it("freezing a never-configured agent creates an implicit row", () => {
    const limit = setAgentSpendingLimitFrozen(db, merchantId, agentId, true);
    expect(limit).not.toBeNull();
    expect(limit?.frozen).toBe(true);
    expect(limit?.maxPerRequest).toBeNull();
  });
});

describe("agent spending limit routes", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let agentId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Routes Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `routes-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const identity = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: `agent-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
    });
    agentId = identity.id;
    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("PUT sets and returns the limit", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/limits`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPerRequest: 5, dailyCap: 100 }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limit: { maxPerRequest: number; dailyCap: number; frozen: boolean };
    };
    expect(body.limit.maxPerRequest).toBe(5);
    expect(body.limit.dailyCap).toBe(100);
    expect(body.limit.frozen).toBe(false);
  });

  it("PUT accepts null caps to disable individual checks", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/limits`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPerRequest: 10, dailyCap: null }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limit: { maxPerRequest: number; dailyCap: number | null };
    };
    expect(body.limit.dailyCap).toBeNull();
  });

  it("PUT rejects negative values", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/limits`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPerRequest: -1, dailyCap: 100 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("PUT 404s for unknown agent", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/agents/agt_nope/limits`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPerRequest: 5, dailyCap: 100 }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("POST freeze flips the frozen flag and unfreeze restores it", async () => {
    const freezeRes = await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/freeze`,
      { method: "POST" },
    );
    expect(freezeRes.status).toBe(200);
    let stored = findAgentSpendingLimit(db, merchantId, agentId);
    expect(stored?.frozen).toBe(true);

    const unfreezeRes = await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/unfreeze`,
      { method: "POST" },
    );
    expect(unfreezeRes.status).toBe(200);
    stored = findAgentSpendingLimit(db, merchantId, agentId);
    expect(stored?.frozen).toBe(false);
  });

  it("GET list returns all configured limits for a merchant", async () => {
    await fetch(
      `${server.url}/merchants/${merchantId}/agents/${agentId}/limits`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxPerRequest: 5, dailyCap: 100 }),
      },
    );
    const res = await fetch(`${server.url}/merchants/${merchantId}/agents/limits`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      limits: Array<{ agentIdentityId: string; maxPerRequest: number }>;
    };
    expect(body.limits.length).toBe(1);
    expect(body.limits[0]?.agentIdentityId).toBe(agentId);
  });
});

describe("/pay agent spending integration", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let agentRowId: string;
  let agentExternalId: string;
  let agentPublicKey: string;
  let agentPrivateKey: ReturnType<typeof makeAgentKeypair>["privateKey"];

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Integ Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `integ-asl-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;

    const kp = makeAgentKeypair();
    agentPublicKey = kp.publicKey;
    agentPrivateKey = kp.privateKey;
    agentExternalId = `claude-${Date.now()}`;
    const identity = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: agentExternalId,
      publicKey: agentPublicKey,
      displayName: "Test Agent",
      ownerEmail: null,
    });
    agentRowId = identity.id;

    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  function freshAgentHeader(): string {
    return buildAgentHeader({
      provider: "anthropic",
      agentId: agentExternalId,
      publicKey: agentPublicKey,
      privateKey: agentPrivateKey,
    });
  }

  it("tags the payment row with the verified agent identity id", async () => {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshAgentHeader(),
      },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { agentIdentityId: string };
    };
    expect(body.payment.agentIdentityId).toBe(agentRowId);
  });

  it("returns 403 when the agent is frozen", async () => {
    setAgentSpendingLimitFrozen(db, merchantId, agentRowId, true);
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshAgentHeader(),
      },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 429 when amount exceeds max_per_request", async () => {
    upsertAgentSpendingLimit(db, {
      merchantId,
      agentIdentityId: agentRowId,
      maxPerRequest: 5,
      dailyCap: null,
    });
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshAgentHeader(),
      },
      body: JSON.stringify({
        merchantId,
        amount: 50,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(429);
  });

  it("returns 429 when the rolling daily cap would be exceeded", async () => {
    upsertAgentSpendingLimit(db, {
      merchantId,
      agentIdentityId: agentRowId,
      maxPerRequest: null,
      dailyCap: 10,
    });
    // First payment (8 USDC) is allowed.
    const ok = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshAgentHeader(),
      },
      body: JSON.stringify({
        merchantId,
        amount: 8,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(ok.status).toBe(201);
    // Second payment (5 USDC) would push to 13 > 10 cap.
    const blocked = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshAgentHeader(),
      },
      body: JSON.stringify({
        merchantId,
        amount: 5,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(blocked.status).toBe(429);
  });

  it("payments without AGENT_HEADER bypass per-agent limits", async () => {
    setAgentSpendingLimitFrozen(db, merchantId, agentRowId, true);
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { agentIdentityId: string | null };
    };
    expect(body.payment.agentIdentityId).toBeNull();
  });

  it("ensures the agent identity row still exists (sanity)", () => {
    expect(findAgentIdentityById(db, agentRowId)).not.toBeNull();
  });
});
