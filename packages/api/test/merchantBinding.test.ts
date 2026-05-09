import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MERCHANT_HANDLE_MAX_LEN,
  MERCHANT_HANDLE_MIN_LEN,
  ZETTAPAY_PROGRAM_ID,
  deriveMerchantBindingPda,
  isValidMerchantHandle,
} from "../src/solana/merchantBinding.js";

describe("isValidMerchantHandle", () => {
  it("accepts the documented handle alphabet", () => {
    for (const handle of ["acme", "acme-store", "acme_store_42", "0xfoo"]) {
      expect(isValidMerchantHandle(handle)).toBe(true);
    }
  });

  it("rejects handles outside the on-chain constraints", () => {
    for (const handle of ["", "ab", "ACME", "-acme", "_acme", "acme.store", "acme store"]) {
      expect(isValidMerchantHandle(handle)).toBe(false);
    }
  });

  it("enforces the documented length window", () => {
    expect(isValidMerchantHandle("a".repeat(MERCHANT_HANDLE_MIN_LEN))).toBe(true);
    expect(isValidMerchantHandle("a".repeat(MERCHANT_HANDLE_MAX_LEN))).toBe(true);
    expect(isValidMerchantHandle("a".repeat(MERCHANT_HANDLE_MAX_LEN + 1))).toBe(false);
  });
});

describe("deriveMerchantBindingPda", () => {
  const owner = Keypair.generate().publicKey;

  it("produces a deterministic off-curve PDA owned by the program", () => {
    const a = deriveMerchantBindingPda("acme", owner);
    const b = deriveMerchantBindingPda("acme", owner);
    expect(a.pda.equals(b.pda)).toBe(true);
    expect(a.bump).toBe(b.bump);
    expect(PublicKey.isOnCurve(a.pda.toBytes())).toBe(false);
  });

  it("uses [handle, owner] seeds — matches the Rust program byte-for-byte", () => {
    const handle = "acme-store";
    const expected = PublicKey.findProgramAddressSync(
      [Buffer.from(handle, "utf8"), owner.toBuffer()],
      ZETTAPAY_PROGRAM_ID,
    );
    const got = deriveMerchantBindingPda(handle, owner);
    expect(got.pda.equals(expected[0])).toBe(true);
    expect(got.bump).toBe(expected[1]);
  });

  it("isolates bindings per owner — the same handle yields different PDAs", () => {
    const otherOwner = Keypair.generate().publicKey;
    const mine = deriveMerchantBindingPda("acme", owner);
    const theirs = deriveMerchantBindingPda("acme", otherOwner);
    expect(mine.pda.equals(theirs.pda)).toBe(false);
  });

  it("rejects handles that violate program-side validation", () => {
    expect(() => deriveMerchantBindingPda("ACME", owner)).toThrow(/violates/);
  });
});
