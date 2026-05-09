import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  PAYMENT_ID_LEN,
  TX_SIGNATURE_LEN,
  derivePaymentPda,
} from "../src/solana/paymentRecord.js";
import { ZETTAPAY_PROGRAM_ID } from "../src/solana/merchantBinding.js";

const merchantBinding = Keypair.generate().publicKey;

function paymentIdOf(byte: number): Uint8Array {
  return new Uint8Array(PAYMENT_ID_LEN).fill(byte);
}

describe("derivePaymentPda", () => {
  it("produces a deterministic off-curve PDA owned by the program", () => {
    const id = paymentIdOf(7);
    const a = derivePaymentPda(merchantBinding, id);
    const b = derivePaymentPda(merchantBinding, id);
    expect(a.pda.equals(b.pda)).toBe(true);
    expect(a.bump).toBe(b.bump);
    expect(PublicKey.isOnCurve(a.pda.toBytes())).toBe(false);
  });

  it("uses [merchant_binding, payment_id] seeds — matches the Rust program byte-for-byte", () => {
    const id = paymentIdOf(42);
    const expected = PublicKey.findProgramAddressSync(
      [merchantBinding.toBuffer(), Buffer.from(id)],
      ZETTAPAY_PROGRAM_ID,
    );
    const got = derivePaymentPda(merchantBinding, id);
    expect(got.pda.equals(expected[0])).toBe(true);
    expect(got.bump).toBe(expected[1]);
  });

  it("isolates receipts per merchant — same payment_id yields different PDAs", () => {
    const id = paymentIdOf(1);
    const otherBinding = Keypair.generate().publicKey;
    const mine = derivePaymentPda(merchantBinding, id);
    const theirs = derivePaymentPda(otherBinding, id);
    expect(mine.pda.equals(theirs.pda)).toBe(false);
  });

  it("isolates receipts per payment_id — same merchant yields different PDAs", () => {
    const a = derivePaymentPda(merchantBinding, paymentIdOf(1));
    const b = derivePaymentPda(merchantBinding, paymentIdOf(2));
    expect(a.pda.equals(b.pda)).toBe(false);
  });

  it("rejects payment_id with the wrong length", () => {
    expect(() => derivePaymentPda(merchantBinding, new Uint8Array(0))).toThrow(/exactly 32/);
    expect(() => derivePaymentPda(merchantBinding, new Uint8Array(31))).toThrow(/exactly 32/);
    expect(() => derivePaymentPda(merchantBinding, new Uint8Array(33))).toThrow(/exactly 32/);
  });

  it("exposes the canonical signature length matching the Rust program", () => {
    expect(TX_SIGNATURE_LEN).toBe(64);
  });
});
