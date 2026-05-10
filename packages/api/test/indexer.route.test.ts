import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  PAYMENT_ACCOUNT_SIZE,
  PAYMENT_DISCRIMINATOR,
  PAYMENT_OFFSETS,
} from "../src/solana/idl.js";
import { ZETTAPAY_PROGRAM_ID } from "../src/solana/merchantBinding.js";
import { OnChainPaymentIndexer } from "../src/services/onchain_indexer.js";
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

function makeFakeSolana(): SolanaService {
  return {
    getPayerPublicKey: () => Keypair.generate().publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(),
  } as unknown as SolanaService;
}

function encodePayment(args: {
  merchantBinding: PublicKey;
  paymentId: Uint8Array;
  amount: bigint;
  txSignature: Uint8Array;
  recordedAt: bigint;
}): Buffer {
  const buf = Buffer.alloc(PAYMENT_ACCOUNT_SIZE);
  Buffer.from(PAYMENT_DISCRIMINATOR).copy(buf, PAYMENT_OFFSETS.discriminator);
  buf.writeUInt8(254, PAYMENT_OFFSETS.bump);
  args.merchantBinding.toBuffer().copy(buf, PAYMENT_OFFSETS.merchantBinding);
  Buffer.from(args.paymentId).copy(buf, PAYMENT_OFFSETS.paymentId);
  buf.writeBigUInt64LE(args.amount, PAYMENT_OFFSETS.amount);
  Buffer.from(args.txSignature).copy(buf, PAYMENT_OFFSETS.txSignature);
  buf.writeBigInt64LE(args.recordedAt, PAYMENT_OFFSETS.recordedAt);
  return buf;
}

class StubConnection {
  constructor(private readonly accounts: Map<string, Buffer>) {}
  async getAccountInfo(
    pubkey: PublicKey,
  ): Promise<{ owner: PublicKey; data: Buffer } | null> {
    const data = this.accounts.get(pubkey.toBase58());
    if (!data) return null;
    return { owner: ZETTAPAY_PROGRAM_ID, data };
  }
  async getProgramAccounts(): Promise<
    Array<{ pubkey: PublicKey; account: { data: Buffer } }>
  > {
    return [...this.accounts.entries()].map(([pda, data]) => ({
      pubkey: new PublicKey(pda),
      account: { data },
    }));
  }
}

const VALID_KEY = "test-indexer-key-please-replace-me";
const SHORT_KEY = "too-short";

describe("/indexer/onchain/payments", () => {
  let db: Db;
  let server: RunningServer;
  let indexer: OnChainPaymentIndexer;
  let onChainAccounts: Map<string, Buffer>;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    onChainAccounts = new Map();
    const conn = new StubConnection(onChainAccounts) as unknown as Connection;
    indexer = new OnChainPaymentIndexer(db, conn);
    const app = createApp({
      db,
      solana: makeFakeSolana(),
      indexer: { webhookAuthKey: VALID_KEY, indexer },
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("rejects webhook calls without auth", async () => {
    const res = await fetch(
      `${server.url}/indexer/onchain/payments/webhook`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ events: [] }),
      },
    );
    expect(res.status).toBe(401);
  });

  it("ingests inline-data events through the generic shape", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const data = encodePayment({
      merchantBinding,
      paymentId: Uint8Array.from({ length: 32 }, (_, i) => i),
      amount: 7n,
      txSignature: Uint8Array.from({ length: 64 }, (_, i) => i + 1),
      recordedAt: 1_700_000_007n,
    });

    const res = await fetch(
      `${server.url}/indexer/onchain/payments/webhook`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-indexer-auth": VALID_KEY,
        },
        body: JSON.stringify({
          events: [
            { pda: pda.toBase58(), data: data.toString("base64"), slot: 5 },
          ],
        }),
      },
    );
    expect(res.status).toBe(200);
    const stats = (await res.json()) as {
      ingested: number;
      inserted: number;
      errors: unknown[];
    };
    expect(stats).toMatchObject({ ingested: 1, inserted: 1, errors: [] });

    const list = await fetch(
      `${server.url}/indexer/onchain/payments?merchantBinding=${merchantBinding.toBase58()}`,
    );
    const body = (await list.json()) as {
      payments: Array<{ amount: string; merchantBinding: string }>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.payments[0]!.amount).toBe("7");
    expect(body.payments[0]!.merchantBinding).toBe(merchantBinding.toBase58());
  });

  it("falls back to RPC fetch when the webhook event omits data", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    onChainAccounts.set(
      pda.toBase58(),
      encodePayment({
        merchantBinding,
        paymentId: Uint8Array.from({ length: 32 }, () => 9),
        amount: 100n,
        txSignature: Uint8Array.from({ length: 64 }, () => 7),
        recordedAt: 1_700_111_000n,
      }),
    );

    const res = await fetch(
      `${server.url}/indexer/onchain/payments/webhook`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-indexer-auth": VALID_KEY,
        },
        body: JSON.stringify({ events: [{ pda: pda.toBase58() }] }),
      },
    );
    expect(res.status).toBe(200);
    const stats = (await res.json()) as { ingested: number; inserted: number };
    expect(stats.ingested).toBe(1);
    expect(stats.inserted).toBe(1);
  });

  it("accepts the Helius account-webhook envelope shape", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    onChainAccounts.set(
      pda.toBase58(),
      encodePayment({
        merchantBinding,
        paymentId: Uint8Array.from({ length: 32 }, () => 4),
        amount: 33n,
        txSignature: Uint8Array.from({ length: 64 }, () => 4),
        recordedAt: 1_700_500_000n,
      }),
    );

    const res = await fetch(
      `${server.url}/indexer/onchain/payments/webhook`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-indexer-auth": VALID_KEY,
        },
        body: JSON.stringify([
          {
            slot: 12345,
            accountData: [{ account: pda.toBase58() }],
          },
        ]),
      },
    );
    expect(res.status).toBe(200);
    const stats = (await res.json()) as { ingested: number };
    expect(stats.ingested).toBe(1);
  });

  it("returns the mirror via GET, paginated by recordedAt cursor", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    for (let i = 0; i < 3; i++) {
      const pda = Keypair.generate().publicKey;
      const data = encodePayment({
        merchantBinding,
        paymentId: Uint8Array.from({ length: 32 }, () => i + 1),
        amount: BigInt(i + 1),
        txSignature: Uint8Array.from({ length: 64 }, () => i + 1),
        recordedAt: BigInt(1_700_000_000 + i),
      });
      indexer.ingestRawAccount({
        pda: pda.toBase58(),
        data: data.toString("base64"),
      });
    }

    const res = await fetch(
      `${server.url}/indexer/onchain/payments?merchantBinding=${merchantBinding.toBase58()}&limit=2`,
    );
    const body = (await res.json()) as {
      payments: Array<{ recordedAt: number }>;
      cursor: number | null;
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.payments).toHaveLength(2);
    expect(body.cursor).toBe(1_700_000_001);

    const next = await fetch(
      `${server.url}/indexer/onchain/payments?merchantBinding=${merchantBinding.toBase58()}&limit=2&cursor=${body.cursor}`,
    );
    const nextBody = (await next.json()) as {
      payments: Array<{ recordedAt: number }>;
    };
    expect(nextBody.payments).toHaveLength(1);
    expect(nextBody.payments[0]!.recordedAt).toBe(1_700_000_000);
  });

  it("404s on unknown PDA", async () => {
    const res = await fetch(
      `${server.url}/indexer/onchain/payments/${Keypair.generate().publicKey.toBase58()}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns config_error when the webhook key is too short", async () => {
    closeDatabase();
    const db2 = openDatabase(":memory:");
    const app = createApp({
      db: db2,
      solana: makeFakeSolana(),
      indexer: { webhookAuthKey: SHORT_KEY, indexer },
    });
    const local = await startApp(app);
    try {
      const res = await fetch(
        `${local.url}/indexer/onchain/payments/webhook`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-indexer-auth": SHORT_KEY,
          },
          body: JSON.stringify({ events: [{ pda: "abc" }] }),
        },
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("config_error");
    } finally {
      await local.close();
    }
  });
});
