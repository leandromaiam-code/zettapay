import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PAYMENT_ACCOUNT_SIZE,
  PAYMENT_DISCRIMINATOR,
  PAYMENT_ID_BYTES,
  PAYMENT_OFFSETS,
  PAYMENT_TX_SIGNATURE_BYTES,
} from "../src/solana/idl.js";
import {
  PaymentAccountDecodeError,
  decodePaymentAccount,
} from "../src/solana/paymentAccount.js";

const repoRoot = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..");
})();

interface CommittedIdl {
  address: string;
  accounts: Array<{ name: string; discriminator: number[] }>;
}

const committedIdl = JSON.parse(
  readFileSync(join(repoRoot, "idl", "zettapay.json"), "utf8"),
) as CommittedIdl;

interface PaymentEncodeInput {
  bump: number;
  merchantBinding: PublicKey;
  paymentId: Uint8Array;
  amount: bigint;
  txSignature: Uint8Array;
  recordedAt: bigint;
}

function encodePaymentAccount(input: PaymentEncodeInput): Buffer {
  const buf = Buffer.alloc(PAYMENT_ACCOUNT_SIZE);
  Buffer.from(PAYMENT_DISCRIMINATOR).copy(buf, PAYMENT_OFFSETS.discriminator);
  buf.writeUInt8(input.bump, PAYMENT_OFFSETS.bump);
  input.merchantBinding.toBuffer().copy(buf, PAYMENT_OFFSETS.merchantBinding);
  Buffer.from(input.paymentId).copy(buf, PAYMENT_OFFSETS.paymentId);
  buf.writeBigUInt64LE(input.amount, PAYMENT_OFFSETS.amount);
  Buffer.from(input.txSignature).copy(buf, PAYMENT_OFFSETS.txSignature);
  buf.writeBigInt64LE(input.recordedAt, PAYMENT_OFFSETS.recordedAt);
  return buf;
}

describe("Payment IDL constants pin the committed IDL", () => {
  it("Payment discriminator is byte-for-byte the committed IDL", () => {
    const account = committedIdl.accounts.find((a) => a.name === "Payment");
    expect(account).toBeDefined();
    expect(Array.from(PAYMENT_DISCRIMINATOR)).toEqual(account!.discriminator);
  });

  it("PAYMENT_ACCOUNT_SIZE matches the Rust struct (153B)", () => {
    expect(PAYMENT_ACCOUNT_SIZE).toBe(153);
    expect(PAYMENT_TX_SIGNATURE_BYTES).toBe(64);
    expect(PAYMENT_ID_BYTES).toBe(32);
  });

  it("offsets are sequential and exhaustive", () => {
    expect(PAYMENT_OFFSETS.bump).toBe(8);
    expect(PAYMENT_OFFSETS.merchantBinding).toBe(9);
    expect(PAYMENT_OFFSETS.paymentId).toBe(41);
    expect(PAYMENT_OFFSETS.amount).toBe(73);
    expect(PAYMENT_OFFSETS.txSignature).toBe(81);
    expect(PAYMENT_OFFSETS.recordedAt).toBe(145);
    expect(PAYMENT_OFFSETS.recordedAt + 8).toBe(PAYMENT_ACCOUNT_SIZE);
  });
});

describe("decodePaymentAccount", () => {
  const merchantBinding = Keypair.generate().publicKey;
  const paymentId = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
  const txSignature = Uint8Array.from({ length: 64 }, (_, i) => (i * 3) & 0xff);
  const pdaPk = Keypair.generate().publicKey;

  it("round-trips a synthetic Payment buffer", () => {
    const buf = encodePaymentAccount({
      bump: 254,
      merchantBinding,
      paymentId,
      amount: 12_345_678n,
      txSignature,
      recordedAt: 1_700_000_000n,
    });
    const record = decodePaymentAccount(buf, pdaPk);
    expect(record.pda).toBe(pdaPk.toBase58());
    expect(record.bump).toBe(254);
    expect(record.merchantBinding).toBe(merchantBinding.toBase58());
    expect(record.paymentIdHex).toBe(Buffer.from(paymentId).toString("hex"));
    expect(record.amount).toBe(12_345_678n);
    expect(record.txSignature).toBe(bs58.encode(txSignature));
    expect(record.recordedAt).toBe(1_700_000_000);
  });

  it("rejects accounts with the wrong discriminator", () => {
    const buf = encodePaymentAccount({
      bump: 0,
      merchantBinding,
      paymentId,
      amount: 1n,
      txSignature,
      recordedAt: 0n,
    });
    buf[0] = 0; // corrupt discriminator
    expect(() => decodePaymentAccount(buf, pdaPk)).toThrow(
      PaymentAccountDecodeError,
    );
  });

  it("rejects truncated buffers", () => {
    const buf = encodePaymentAccount({
      bump: 0,
      merchantBinding,
      paymentId,
      amount: 1n,
      txSignature,
      recordedAt: 0n,
    });
    expect(() => decodePaymentAccount(buf.subarray(0, 100), pdaPk)).toThrow(
      /too small/,
    );
  });

  it("preserves u64 amounts that exceed Number.MAX_SAFE_INTEGER", () => {
    // 10 billion USDC in raw units (6 decimals) would still fit in number, but
    // the on-chain amount field is u64 — clients must not lose precision when
    // a future product (treasury sweep, agent escrow) fills the field with
    // high values. BigInt ensures that.
    const huge = (2n ** 63n) - 1n;
    const buf = encodePaymentAccount({
      bump: 1,
      merchantBinding,
      paymentId,
      amount: huge,
      txSignature,
      recordedAt: 1n,
    });
    const record = decodePaymentAccount(buf, pdaPk);
    expect(record.amount).toBe(huge);
  });
});
