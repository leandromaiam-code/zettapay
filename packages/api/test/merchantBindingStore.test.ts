import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MERCHANT_BINDING_DISCRIMINATOR,
  MERCHANT_BINDING_HANDLE_MAX_LEN,
  MERCHANT_BINDING_OFFSETS,
  PAYMENT_DISCRIMINATOR,
  ZETTAPAY_PROGRAM_ADDRESS,
} from "../src/solana/idl.js";
import {
  MerchantBindingDecodeError,
  decodeMerchantBinding,
} from "../src/solana/merchantBindingStore.js";

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

function discriminatorFor(accountName: string): number[] {
  const account = committedIdl.accounts.find((a) => a.name === accountName);
  if (!account) throw new Error(`IDL missing ${accountName}`);
  return account.discriminator;
}

function encodeMerchantBinding(input: {
  bump: number;
  owner: PublicKey;
  usdcTokenAccount: PublicKey;
  merchantHandle: string;
  registeredAt: bigint;
}): Buffer {
  const handleBytes = Buffer.from(input.merchantHandle, "utf8");
  const buf = Buffer.alloc(
    MERCHANT_BINDING_OFFSETS.merchantHandleStart + handleBytes.length + 8,
  );
  Buffer.from(MERCHANT_BINDING_DISCRIMINATOR).copy(buf, 0);
  buf.writeUInt8(input.bump, MERCHANT_BINDING_OFFSETS.bump);
  input.owner.toBuffer().copy(buf, MERCHANT_BINDING_OFFSETS.owner);
  input.usdcTokenAccount
    .toBuffer()
    .copy(buf, MERCHANT_BINDING_OFFSETS.usdcTokenAccount);
  buf.writeUInt32LE(
    handleBytes.length,
    MERCHANT_BINDING_OFFSETS.merchantHandleLen,
  );
  handleBytes.copy(buf, MERCHANT_BINDING_OFFSETS.merchantHandleStart);
  buf.writeBigInt64LE(
    input.registeredAt,
    MERCHANT_BINDING_OFFSETS.merchantHandleStart + handleBytes.length,
  );
  return buf;
}

describe("zettapay IDL constants", () => {
  it("program address mirrors the committed IDL", () => {
    expect(ZETTAPAY_PROGRAM_ADDRESS).toBe(committedIdl.address);
  });

  it("MerchantBinding discriminator is byte-for-byte the committed IDL", () => {
    expect(Array.from(MERCHANT_BINDING_DISCRIMINATOR)).toEqual(
      discriminatorFor("MerchantBinding"),
    );
  });

  it("Payment discriminator is byte-for-byte the committed IDL", () => {
    expect(Array.from(PAYMENT_DISCRIMINATOR)).toEqual(discriminatorFor("Payment"));
  });

  it("offsets describe a contiguous Anchor account layout", () => {
    expect(MERCHANT_BINDING_OFFSETS.discriminator).toBe(0);
    expect(MERCHANT_BINDING_OFFSETS.bump).toBe(8);
    expect(MERCHANT_BINDING_OFFSETS.owner).toBe(9);
    expect(MERCHANT_BINDING_OFFSETS.usdcTokenAccount).toBe(41);
    expect(MERCHANT_BINDING_OFFSETS.merchantHandleLen).toBe(73);
    expect(MERCHANT_BINDING_OFFSETS.merchantHandleStart).toBe(77);
    expect(MERCHANT_BINDING_HANDLE_MAX_LEN).toBe(32);
  });
});

describe("decodeMerchantBinding", () => {
  const owner = Keypair.generate().publicKey;
  const usdcAta = Keypair.generate().publicKey;

  it("round-trips a freshly-registered binding", () => {
    const data = encodeMerchantBinding({
      bump: 254,
      owner,
      usdcTokenAccount: usdcAta,
      merchantHandle: "acme-store",
      registeredAt: 1_700_000_000n,
    });
    const pda = Keypair.generate().publicKey;
    const decoded = decodeMerchantBinding(data, pda);
    expect(decoded).toEqual({
      pda: pda.toBase58(),
      bump: 254,
      owner: owner.toBase58(),
      usdcTokenAccount: usdcAta.toBase58(),
      merchantHandle: "acme-store",
      registeredAt: 1_700_000_000,
    });
  });

  it("decodes the maximum-length handle (32 bytes)", () => {
    const handle = "a".repeat(MERCHANT_BINDING_HANDLE_MAX_LEN);
    const data = encodeMerchantBinding({
      bump: 1,
      owner,
      usdcTokenAccount: usdcAta,
      merchantHandle: handle,
      registeredAt: 0n,
    });
    expect(decodeMerchantBinding(data).merchantHandle).toBe(handle);
  });

  it("rejects accounts whose discriminator is not MerchantBinding", () => {
    const data = encodeMerchantBinding({
      bump: 1,
      owner,
      usdcTokenAccount: usdcAta,
      merchantHandle: "acme",
      registeredAt: 0n,
    });
    Buffer.from(PAYMENT_DISCRIMINATOR).copy(data, 0);
    expect(() => decodeMerchantBinding(data)).toThrow(MerchantBindingDecodeError);
    expect(() => decodeMerchantBinding(data)).toThrow(/discriminator mismatch/);
  });

  it("rejects accounts shorter than the fixed prefix", () => {
    const tooShort = Buffer.alloc(MERCHANT_BINDING_OFFSETS.merchantHandleStart);
    Buffer.from(MERCHANT_BINDING_DISCRIMINATOR).copy(tooShort, 0);
    expect(() => decodeMerchantBinding(tooShort)).toThrow(/account too small/);
  });

  it("rejects accounts whose handle length exceeds program max", () => {
    const data = encodeMerchantBinding({
      bump: 1,
      owner,
      usdcTokenAccount: usdcAta,
      merchantHandle: "acme",
      registeredAt: 0n,
    });
    data.writeUInt32LE(33, MERCHANT_BINDING_OFFSETS.merchantHandleLen);
    expect(() => decodeMerchantBinding(data)).toThrow(/exceeds program max/);
  });

  it("rejects accounts truncated before registered_at", () => {
    const data = encodeMerchantBinding({
      bump: 1,
      owner,
      usdcTokenAccount: usdcAta,
      merchantHandle: "acme",
      registeredAt: 0n,
    });
    const truncated = data.subarray(0, data.length - 1);
    expect(() => decodeMerchantBinding(truncated)).toThrow(
      /truncated before registered_at/,
    );
  });
});
