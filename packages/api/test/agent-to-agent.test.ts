import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  findAgentIdentityById,
  insertAgentIdentity,
  setAgentIdentityPayoutWallet,
} from "../src/db/agent_identities.js";
import {
  insertAgentToAgentPayment,
  listAgentToAgentPayments,
  markAgentToAgentPaymentCompleted,
} from "../src/db/agent_to_agent_payments.js";
import {
  AGENT_TO_AGENT_DAILY_CAP,
  AGENT_TO_AGENT_MAX_PER_REQUEST,
  createAgentToAgentPayment,
} from "../src/services/agent-to-agent.js";
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
    getUsdcMintAddress: () =>
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
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

interface AgentKeyPair {
  publicKey: string;
  privateKey: KeyObject;
}

function makeAgentKeypair(): AgentKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

function buildAgentHeader(input: {
  provider: "anthropic" | "openai";
  agentId: string;
  publicKey: string;
  privateKey: KeyObject;
}): string {
  const proof = signAgentProof({
    provider: input.provider,
    agentId: input.agentId,
    publicKey: input.publicKey,
    privateKey: input.privateKey,
  });
  return encodeAgentProof(proof);
}

describe("createAgentToAgentPayment service", () => {
  let db: Db;
  let payerId: string;
  let payeeId: string;
  let payeeWallet: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    payeeWallet = Keypair.generate().publicKey.toBase58();
    const payer = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: `payer-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
    });
    const payee = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "openai",
      agentId: `payee-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
      payoutWallet: payeeWallet,
    });
    payerId = payer.id;
    payeeId = payee.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("creates a completed payment and tags both ends", async () => {
    const solana = makeFakeSolana(Keypair.generate());
    const { payment } = await createAgentToAgentPayment(db, solana, {
      payerAgentIdentityId: payerId,
      payeeAgentIdentityId: payeeId,
      amountUsdc: 0.05,
      taskRef: "task-123",
    });
    expect(payment.status).toBe("completed");
    expect(payment.payerAgentIdentityId).toBe(payerId);
    expect(payment.payeeAgentIdentityId).toBe(payeeId);
    expect(payment.payeeWallet).toBe(payeeWallet);
    expect(payment.taskRef).toBe("task-123");
    expect(payment.txSignature).toBeTruthy();
  });

  it("rejects self-payments", async () => {
    const solana = makeFakeSolana(Keypair.generate());
    await expect(
      createAgentToAgentPayment(db, solana, {
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: payerId,
        amountUsdc: 0.01,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects when payee has no payout wallet", async () => {
    const noWalletPayee = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "google",
      agentId: `nw-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
    });
    const solana = makeFakeSolana(Keypair.generate());
    await expect(
      createAgentToAgentPayment(db, solana, {
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: noWalletPayee.id,
        amountUsdc: 0.01,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects amounts above the per-request ceiling", async () => {
    const solana = makeFakeSolana(Keypair.generate());
    await expect(
      createAgentToAgentPayment(db, solana, {
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: payeeId,
        amountUsdc: AGENT_TO_AGENT_MAX_PER_REQUEST + 1,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("enforces the rolling 24h daily cap", async () => {
    // Pre-fill the payer's window with completed A2A spend just below the cap.
    const fillAmount = AGENT_TO_AGENT_MAX_PER_REQUEST;
    let total = 0;
    while (total + fillAmount <= AGENT_TO_AGENT_DAILY_CAP) {
      const id = `a2a_fill_${total}`;
      insertAgentToAgentPayment(db, {
        id,
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: payeeId,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        payeeWallet,
        amountUsdc: fillAmount,
      });
      markAgentToAgentPaymentCompleted(db, id, `sig_${id}`);
      total += fillAmount;
    }
    const solana = makeFakeSolana(Keypair.generate());
    await expect(
      createAgentToAgentPayment(db, solana, {
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: payeeId,
        amountUsdc: 1,
      }),
    ).rejects.toMatchObject({ status: 429 });
  });

  it("marks the payment failed on transfer error", async () => {
    const solana = {
      ...makeFakeSolana(Keypair.generate()),
      transferToken: vi.fn(async () => {
        throw new Error("rpc down");
      }),
    } as unknown as SolanaService;
    await expect(
      createAgentToAgentPayment(db, solana, {
        payerAgentIdentityId: payerId,
        payeeAgentIdentityId: payeeId,
        amountUsdc: 1,
      }),
    ).rejects.toMatchObject({ status: 502 });
    const rows = listAgentToAgentPayments(db, {
      agentIdentityId: payerId,
      role: "payer",
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.errorMessage).toContain("rpc down");
  });
});

describe("/agents/pay route", () => {
  let db: Db;
  let server: RunningServer;
  let payerExternalId: string;
  let payerKey: AgentKeyPair;
  let payerRowId: string;
  let payeeRowId: string;
  let payeeWallet: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");

    payerKey = makeAgentKeypair();
    payerExternalId = `pay-payer-${Date.now()}`;
    const payer = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: payerExternalId,
      publicKey: payerKey.publicKey,
      displayName: null,
      ownerEmail: null,
    });
    payerRowId = payer.id;

    payeeWallet = Keypair.generate().publicKey.toBase58();
    const payee = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "openai",
      agentId: `pay-payee-${Date.now()}`,
      publicKey: makeAgentKeypair().publicKey,
      displayName: null,
      ownerEmail: null,
      payoutWallet: payeeWallet,
    });
    payeeRowId = payee.id;

    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  function freshHeader(): string {
    return buildAgentHeader({
      provider: "anthropic",
      agentId: payerExternalId,
      publicKey: payerKey.publicKey,
      privateKey: payerKey.privateKey,
    });
  }

  it("happy path with payeeAgentIdentityId returns 201", async () => {
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({
        payeeAgentIdentityId: payeeRowId,
        amount: 0.01,
        taskRef: "scrape-page",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: {
        payerAgentIdentityId: string;
        payeeAgentIdentityId: string;
        status: string;
        taskRef: string;
        payeeWallet: string;
      };
    };
    expect(body.payment.status).toBe("completed");
    expect(body.payment.payerAgentIdentityId).toBe(payerRowId);
    expect(body.payment.payeeAgentIdentityId).toBe(payeeRowId);
    expect(body.payment.taskRef).toBe("scrape-page");
    expect(body.payment.payeeWallet).toBe(payeeWallet);
  });

  it("happy path with payee provider+agentId object", async () => {
    const payee = findAgentIdentityById(db, payeeRowId);
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({
        payee: { provider: "openai", agentId: payee?.agentId },
        amount: 0.5,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      payment: { payeeAgentIdentityId: string };
    };
    expect(body.payment.payeeAgentIdentityId).toBe(payeeRowId);
  });

  it("401 when AGENT_HEADER is missing", async () => {
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payeeAgentIdentityId: payeeRowId, amount: 1 }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when payee identity is unknown", async () => {
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payeeAgentIdentityId: "agt_nope", amount: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("400 when payee has no payout wallet", async () => {
    setAgentIdentityPayoutWallet(db, payeeRowId, null);
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payeeAgentIdentityId: payeeRowId, amount: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("400 on self-pay", async () => {
    const res = await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payeeAgentIdentityId: payerRowId, amount: 1 }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /agents/identity/:id/payments lists A2A history", async () => {
    await fetch(`${server.url}/agents/pay`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payeeAgentIdentityId: payeeRowId, amount: 0.05 }),
    });
    const listRes = await fetch(
      `${server.url}/agents/identity/${payerRowId}/payments?role=payer`,
    );
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as {
      payments: Array<{ payerAgentIdentityId: string }>;
    };
    expect(body.payments.length).toBe(1);
    expect(body.payments[0]?.payerAgentIdentityId).toBe(payerRowId);
  });
});

describe("PUT /agents/identity/payout-wallet", () => {
  let db: Db;
  let server: RunningServer;
  let identityKey: AgentKeyPair;
  let identityExternalId: string;
  let identityRowId: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    identityKey = makeAgentKeypair();
    identityExternalId = `rotate-${Date.now()}`;
    const identity = insertAgentIdentity(db, {
      id: newId("agt"),
      provider: "anthropic",
      agentId: identityExternalId,
      publicKey: identityKey.publicKey,
      displayName: null,
      ownerEmail: null,
    });
    identityRowId = identity.id;

    const solana = makeFakeSolana(Keypair.generate());
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  function freshHeader(): string {
    return buildAgentHeader({
      provider: "anthropic",
      agentId: identityExternalId,
      publicKey: identityKey.publicKey,
      privateKey: identityKey.privateKey,
    });
  }

  it("rotates the payout wallet when proof matches", async () => {
    const newWallet = Keypair.generate().publicKey.toBase58();
    const res = await fetch(`${server.url}/agents/identity/payout-wallet`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payoutWallet: newWallet }),
    });
    expect(res.status).toBe(200);
    const stored = findAgentIdentityById(db, identityRowId);
    expect(stored?.payoutWallet).toBe(newWallet);
  });

  it("400 when payoutWallet is not a valid Solana address", async () => {
    const res = await fetch(`${server.url}/agents/identity/payout-wallet`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        [AGENT_HEADER]: freshHeader(),
      },
      body: JSON.stringify({ payoutWallet: "not-a-base58-key" }),
    });
    expect(res.status).toBe(400);
  });

  it("401 when AGENT_HEADER is missing", async () => {
    const res = await fetch(`${server.url}/agents/identity/payout-wallet`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        payoutWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(401);
  });
});
