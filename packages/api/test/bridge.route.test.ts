import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import type { SolanaService } from "../src/services/solana.js";
import type {
  AttestationClient,
  AttestationLookup,
  AttestationRecord,
} from "../src/bridge/attestation.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: ReturnType<typeof createApp>): Promise<RunningServer> {
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

function makeFakeSolana(): SolanaService {
  return {
    getCluster: () => "devnet",
    getPayerPublicKey: () => Keypair.generate().publicKey,
  } as unknown as SolanaService;
}

interface IntentBody {
  intent: {
    id: string;
    merchantId: string;
    sourceChain: string;
    sourceNetwork: string;
    sourceCurrency: string;
    destinationCurrency: string;
    recipientWallet: string;
    amountUsdc: number;
    feeUsdc: number;
    netUsdc: number;
    feeBps: number;
    sourceTxHash: string | null;
    attestationHash: string | null;
    attestationStatus: string | null;
    redemptionSignature: string | null;
    paymentId: string | null;
    status: string;
    metadata: Record<string, unknown>;
  };
  source?: { cctpDomain: number; chain: string; network: string };
  destination?: { cctpDomain: number };
  mintRecipientBytes32?: string;
  feeBps?: number;
}

const VALID_HASH = `0x${"a".repeat(64)}`;
const ALT_HASH = `0x${"b".repeat(64)}`;

describe("bridge routes", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let recipientWallet: string;
  let attestationCalls: AttestationLookup[];
  let attestationRecord: AttestationRecord;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchantWallet = Keypair.generate().publicKey.toBase58();
    recipientWallet = Keypair.generate().publicKey.toBase58();
    const merchant = registerMerchant(db, {
      name: "Cross-Chain Coffee",
      walletAddress: merchantWallet,
      email: `merch-${Date.now()}-${Math.random()}@zettapay.test`,
      webhookUrl: null,
    });
    merchantId = merchant.id;

    attestationCalls = [];
    attestationRecord = {
      status: "pending_confirmations",
      message: null,
      attestation: null,
      eventNonce: null,
    };
    const attestation: AttestationClient = {
      fetchAttestation: vi.fn(async (lookup) => {
        attestationCalls.push(lookup);
        return attestationRecord;
      }),
    };

    const app = createApp({
      db,
      solana: makeFakeSolana(),
      attestation,
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("GET /bridge/chains lists supported sources + headline fee", async () => {
    const res = await fetch(`${server.url}/bridge/chains`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sourceChains: string[];
      currencies: string[];
      feeBps: number;
    };
    expect(body.sourceChains.sort()).toEqual(["base", "polygon"]);
    expect(body.currencies).toEqual(["USDC"]);
    expect(body.feeBps).toBe(30);
  });

  it("POST /bridge/quote creates a pending intent + returns CCTP coords", async () => {
    const res = await fetch(`${server.url}/bridge/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sourceChain: "base",
        amount: 100,
        recipientWallet,
        metadata: { invoice: "INV-001" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as IntentBody;
    expect(body.intent.status).toBe("pending");
    expect(body.intent.merchantId).toBe(merchantId);
    expect(body.intent.sourceChain).toBe("base");
    expect(body.intent.sourceNetwork).toBe("testnet");
    expect(body.intent.amountUsdc).toBe(100);
    expect(body.intent.feeUsdc).toBe(0.3);
    expect(body.intent.netUsdc).toBe(99.7);
    expect(body.intent.recipientWallet).toBe(recipientWallet);
    expect(body.intent.metadata.invoice).toBe("INV-001");
    expect(body.source?.cctpDomain).toBe(6);
    expect(body.destination?.cctpDomain).toBe(5);
    expect(body.mintRecipientBytes32).toMatch(/^0x[0-9a-f]{64}$/);
    expect(body.feeBps).toBe(30);
  });

  it("rejects unsupported source chains and non-USDC currencies", async () => {
    const ethRes = await fetch(`${server.url}/bridge/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sourceChain: "ethereum",
        amount: 100,
        recipientWallet,
      }),
    });
    expect(ethRes.status).toBe(400);

    const usdtRes = await fetch(`${server.url}/bridge/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sourceChain: "base",
        currency: "USDT",
        amount: 100,
        recipientWallet,
      }),
    });
    expect(usdtRes.status).toBe(400);
    const usdtBody = (await usdtRes.json()) as {
      error: { message: string };
    };
    expect(usdtBody.error.message).toMatch(/USDC only/);
  });

  it("records the source-tx hash and refuses to swap it later", async () => {
    const intent = await createIntent();

    const ok = await fetch(
      `${server.url}/bridge/intents/${intent.id}/source-tx`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTxHash: VALID_HASH }),
      },
    );
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as IntentBody;
    expect(okBody.intent.status).toBe("burned");
    expect(okBody.intent.sourceTxHash).toBe(VALID_HASH);

    // Same hash → no-op idempotent.
    const repeat = await fetch(
      `${server.url}/bridge/intents/${intent.id}/source-tx`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTxHash: VALID_HASH }),
      },
    );
    expect(repeat.status).toBe(200);

    // Different hash on the same intent → 409.
    const conflict = await fetch(
      `${server.url}/bridge/intents/${intent.id}/source-tx`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTxHash: ALT_HASH }),
      },
    );
    expect(conflict.status).toBe(409);
  });

  it("validates source-tx hash format", async () => {
    const intent = await createIntent();
    const bad = await fetch(
      `${server.url}/bridge/intents/${intent.id}/source-tx`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceTxHash: "0xnope" }),
      },
    );
    expect(bad.status).toBe(400);
  });

  it("/sync projects pending → burned and ready → attested", async () => {
    const intent = await createIntent();
    await fetch(`${server.url}/bridge/intents/${intent.id}/source-tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTxHash: VALID_HASH }),
    });

    // Round 1: still pending at Circle.
    const pending = await fetch(
      `${server.url}/bridge/intents/${intent.id}/sync`,
      { method: "POST" },
    );
    expect(pending.status).toBe(200);
    const pendingBody = (await pending.json()) as IntentBody;
    expect(pendingBody.intent.status).toBe("burned");
    expect(pendingBody.intent.attestationStatus).toBe("pending_confirmations");
    expect(attestationCalls).toHaveLength(1);
    // createIntent() uses polygon — Polygon CCTP domain is 7.
    expect(attestationCalls[0]?.sourceDomain).toBe(7);

    // Round 2: attestation now ready.
    attestationRecord = {
      status: "complete",
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
    };
    const ready = await fetch(
      `${server.url}/bridge/intents/${intent.id}/sync`,
      { method: "POST" },
    );
    const readyBody = (await ready.json()) as IntentBody;
    expect(readyBody.intent.status).toBe("attested");
    expect(readyBody.intent.attestationHash).toBe("0xbeef");
  });

  it("/complete records the redemption sig once attested", async () => {
    const intent = await createIntent();
    await fetch(`${server.url}/bridge/intents/${intent.id}/source-tx`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceTxHash: VALID_HASH }),
    });
    attestationRecord = {
      status: "complete",
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
    };
    await fetch(`${server.url}/bridge/intents/${intent.id}/sync`, {
      method: "POST",
    });

    const done = await fetch(
      `${server.url}/bridge/intents/${intent.id}/complete`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redemptionSignature: "5x".repeat(20) }),
      },
    );
    expect(done.status).toBe(200);
    const body = (await done.json()) as IntentBody;
    expect(body.intent.status).toBe("completed");
    expect(body.intent.redemptionSignature).toBe("5x".repeat(20));
  });

  it("GET /merchants/:id/bridge/intents lists merchant history", async () => {
    await createIntent();
    await createIntent();
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/bridge/intents`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      intents: Array<{ status: string }>;
    };
    expect(body.merchantId).toBe(merchantId);
    expect(body.intents).toHaveLength(2);
  });

  it("returns 404 when bridge routes are mounted but the intent is missing", async () => {
    const res = await fetch(`${server.url}/bridge/intents/brg_does_not_exist`);
    expect(res.status).toBe(404);
  });

  async function createIntent(): Promise<IntentBody["intent"]> {
    const res = await fetch(`${server.url}/bridge/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        sourceChain: "polygon",
        amount: 50,
        recipientWallet,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as IntentBody;
    return body.intent;
  }
});

describe("bridge routes are gated on attestation client", () => {
  it("does not mount /bridge/* without an attestation client", async () => {
    closeDatabase();
    const db = openDatabase(":memory:");
    try {
      const app = createApp({
        db,
        solana: makeFakeSolana(),
      });
      const server = await startApp(app);
      try {
        const res = await fetch(`${server.url}/bridge/chains`);
        expect(res.status).toBe(404);
      } finally {
        await server.close();
      }
    } finally {
      closeDatabase();
    }
  });
});
