import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database as Db } from "better-sqlite3";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  PAYMENT_ACCOUNT_SIZE,
  PAYMENT_DISCRIMINATOR,
  PAYMENT_OFFSETS,
} from "../src/solana/idl.js";
import { ZETTAPAY_PROGRAM_ID } from "../src/solana/merchantBinding.js";
import { OnChainPaymentIndexer } from "../src/services/onchain_indexer.js";
import {
  countOnChainPayments,
  findOnChainPaymentByPda,
  listOnChainPayments,
  upsertOnChainPayment,
} from "../src/db/onchain_payments.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";

function encodePayment(args: {
  merchantBinding: PublicKey;
  paymentId: Uint8Array;
  amount: bigint;
  txSignature: Uint8Array;
  recordedAt: bigint;
  bump?: number;
}): Buffer {
  const buf = Buffer.alloc(PAYMENT_ACCOUNT_SIZE);
  Buffer.from(PAYMENT_DISCRIMINATOR).copy(buf, PAYMENT_OFFSETS.discriminator);
  buf.writeUInt8(args.bump ?? 254, PAYMENT_OFFSETS.bump);
  args.merchantBinding.toBuffer().copy(buf, PAYMENT_OFFSETS.merchantBinding);
  Buffer.from(args.paymentId).copy(buf, PAYMENT_OFFSETS.paymentId);
  buf.writeBigUInt64LE(args.amount, PAYMENT_OFFSETS.amount);
  Buffer.from(args.txSignature).copy(buf, PAYMENT_OFFSETS.txSignature);
  buf.writeBigInt64LE(args.recordedAt, PAYMENT_OFFSETS.recordedAt);
  return buf;
}

function paymentIdOf(byte: number): Uint8Array {
  return Uint8Array.from({ length: 32 }, () => byte);
}
function sigOf(seed: number): Uint8Array {
  return Uint8Array.from({ length: 64 }, (_, i) => (seed + i) & 0xff);
}

// Lightweight Connection stand-in. We never hit the network — methods that
// matter to the indexer are fully overridden so tests stay deterministic.
class StubConnection {
  constructor(private readonly accounts: Map<string, Buffer>) {}
  async getAccountInfo(pubkey: PublicKey): Promise<{
    owner: PublicKey;
    data: Buffer;
  } | null> {
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

describe("OnChainPaymentIndexer", () => {
  let db: Db;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  it("ingests a raw Helius event and writes the mirror row", () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const data = encodePayment({
      merchantBinding,
      paymentId: paymentIdOf(7),
      amount: 5_000_000n,
      txSignature: sigOf(11),
      recordedAt: 1_700_000_001n,
    });
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map()) as unknown as Connection,
    );

    const result = indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
      slot: 999_111,
    });

    expect(result.inserted).toBe(true);
    expect(result.record.merchantBinding).toBe(merchantBinding.toBase58());
    expect(result.record.amount).toBe(5_000_000n);
    expect(result.record.paymentIdHex).toBe(
      Buffer.from(paymentIdOf(7)).toString("hex"),
    );
    expect(result.record.slot).toBe(999_111);

    const persisted = findOnChainPaymentByPda(db, pda.toBase58());
    expect(persisted?.amount).toBe(5_000_000n);
    expect(persisted?.merchantBinding).toBe(merchantBinding.toBase58());
  });

  it("is idempotent: re-ingesting the same PDA does not insert twice", () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const data = encodePayment({
      merchantBinding,
      paymentId: paymentIdOf(1),
      amount: 1n,
      txSignature: sigOf(2),
      recordedAt: 100n,
    });
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map()) as unknown as Connection,
    );

    const first = indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
    });
    const second = indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(countOnChainPayments(db)).toBe(1);
  });

  it("upserts the higher slot when the same PDA is re-seen", () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const data = encodePayment({
      merchantBinding,
      paymentId: paymentIdOf(2),
      amount: 1n,
      txSignature: sigOf(3),
      recordedAt: 100n,
    });
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map()) as unknown as Connection,
    );

    indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
      slot: 100,
    });
    indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
      slot: 200,
    });
    indexer.ingestRawAccount({
      pda: pda.toBase58(),
      data: data.toString("base64"),
      slot: 150, // older — should not overwrite
    });

    const persisted = findOnChainPaymentByPda(db, pda.toBase58());
    expect(persisted?.slot).toBe(200);
  });

  it("rejects divergent re-ingest (corrupted feed protection)", () => {
    const merchantBinding = Keypair.generate().publicKey;
    const otherBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;

    upsertOnChainPayment(db, {
      pda: pda.toBase58(),
      merchantBinding: merchantBinding.toBase58(),
      paymentIdHex: Buffer.from(paymentIdOf(3)).toString("hex"),
      amount: 1n,
      txSignature: "S".repeat(80),
      recordedAt: 100,
    });

    expect(() =>
      upsertOnChainPayment(db, {
        pda: pda.toBase58(),
        merchantBinding: otherBinding.toBase58(),
        paymentIdHex: Buffer.from(paymentIdOf(3)).toString("hex"),
        amount: 1n,
        txSignature: "S".repeat(80),
        recordedAt: 100,
      }),
    ).toThrow(/divergence/);
  });

  it("skips non-Payment accounts in batch ingestion (mixed program webhook)", () => {
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map()) as unknown as Connection,
    );

    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const valid = encodePayment({
      merchantBinding,
      paymentId: paymentIdOf(8),
      amount: 9n,
      txSignature: sigOf(9),
      recordedAt: 9n,
    });
    const garbage = Buffer.alloc(PAYMENT_ACCOUNT_SIZE);
    garbage[0] = 1; // wrong discriminator

    const stats = indexer.ingestRawAccounts([
      {
        pda: pda.toBase58(),
        data: valid.toString("base64"),
      },
      {
        pda: Keypair.generate().publicKey.toBase58(),
        data: garbage.toString("base64"),
      },
    ]);
    expect(stats.ingested).toBe(1);
    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(1);
    expect(stats.errors).toEqual([]);
  });

  it("backfill seeds the mirror from a getProgramAccounts sweep", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    const accounts = new Map<string, Buffer>();
    for (let i = 0; i < 3; i++) {
      const pda = Keypair.generate().publicKey;
      accounts.set(
        pda.toBase58(),
        encodePayment({
          merchantBinding,
          paymentId: paymentIdOf(i + 1),
          amount: BigInt((i + 1) * 1_000_000),
          txSignature: sigOf(i * 4),
          recordedAt: BigInt(1_700_000_000 + i),
        }),
      );
    }
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(accounts) as unknown as Connection,
    );

    const stats = await indexer.backfill();
    expect(stats.inserted).toBe(3);
    expect(stats.errors).toEqual([]);

    const list = listOnChainPayments(db, {
      merchantBinding: merchantBinding.toBase58(),
    });
    expect(list).toHaveLength(3);
    // listOnChainPayments orders by recorded_at DESC.
    expect(list[0]!.recordedAt).toBe(1_700_000_002);
    expect(list[2]!.recordedAt).toBe(1_700_000_000);
  });

  it("ingestByPda fetches via RPC when the webhook omits inline data", async () => {
    const merchantBinding = Keypair.generate().publicKey;
    const pda = Keypair.generate().publicKey;
    const data = encodePayment({
      merchantBinding,
      paymentId: paymentIdOf(5),
      amount: 42n,
      txSignature: sigOf(6),
      recordedAt: 1_700_000_500n,
    });
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map([[pda.toBase58(), data]])) as unknown as Connection,
    );

    const result = await indexer.ingestByPda(pda.toBase58());
    expect(result?.inserted).toBe(true);
    expect(result?.record.amount).toBe(42n);
  });

  it("ingestByPda returns null for a non-existent account", async () => {
    const indexer = new OnChainPaymentIndexer(
      db,
      new StubConnection(new Map()) as unknown as Connection,
    );
    const ghost = Keypair.generate().publicKey;
    const result = await indexer.ingestByPda(ghost.toBase58());
    expect(result).toBeNull();
  });
});
