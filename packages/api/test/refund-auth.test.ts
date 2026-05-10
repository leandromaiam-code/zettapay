import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";
import {
  REFUND_SCHEMA_VERSION,
  REFUND_REASON_MAX_LENGTH,
  RefundAuthError,
  buildRefundIntentMessage,
  verifyRefundIntent,
} from "../src/lib/refund-auth.js";

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

const FIXED_NOW = new Date("2026-05-10T12:00:00.000Z").getTime();
const ISSUED_AT = new Date(FIXED_NOW).toISOString();

describe("refund-auth / canonical message", () => {
  it("emits a stable schema header", () => {
    expect(REFUND_SCHEMA_VERSION).toBe("ZETTAPAY-REFUND-V1");
  });

  it("normalizes amount to 6 decimal places so 10 and 10.0 sign identically", () => {
    const a = buildRefundIntentMessage({
      paymentId: "pay_1",
      merchantWallet: "WALLET",
      amount: 10,
      currency: "USDC",
      reason: "duplicate charge",
      issuedAt: ISSUED_AT,
    });
    const b = buildRefundIntentMessage({
      paymentId: "pay_1",
      merchantWallet: "WALLET",
      amount: 10.0,
      currency: "USDC",
      reason: "duplicate charge",
      issuedAt: ISSUED_AT,
    });
    expect(a.equals(b)).toBe(true);
  });

  it("encodes reason as JSON so newlines in the human text don't break parsing", () => {
    const msg = buildRefundIntentMessage({
      paymentId: "pay_1",
      merchantWallet: "WALLET",
      amount: 1,
      currency: "USDC",
      reason: "line one\nline two",
      issuedAt: ISSUED_AT,
    }).toString("utf8");
    expect(msg).toContain('reason="line one\\nline two"');
  });

  it("rejects an oversized reason", () => {
    expect(() =>
      buildRefundIntentMessage({
        paymentId: "pay_1",
        merchantWallet: "WALLET",
        amount: 1,
        currency: "USDC",
        reason: "x".repeat(REFUND_REASON_MAX_LENGTH + 1),
        issuedAt: ISSUED_AT,
      }),
    ).toThrowError(RefundAuthError);
  });
});

describe("refund-auth / verify", () => {
  it("accepts a fresh, correctly-signed refund intent", () => {
    const { publicKey, privateKey } = makeWallet();
    const intent = {
      paymentId: "pay_42",
      merchantWallet: publicKey,
      amount: 25.5,
      currency: "USDC",
      reason: "customer requested refund",
      issuedAt: ISSUED_AT,
    };
    const message = buildRefundIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    expect(() =>
      verifyRefundIntent({ intent, publicKey, signature, now: FIXED_NOW }),
    ).not.toThrow();
  });

  it("rejects when publicKey does not match merchant wallet", () => {
    const owner = makeWallet();
    const intruder = makeWallet();
    const intent = {
      paymentId: "pay_42",
      merchantWallet: owner.publicKey,
      amount: 25.5,
      currency: "USDC",
      reason: "x",
      issuedAt: ISSUED_AT,
    };
    const message = buildRefundIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, intruder.privateKey));
    let captured: unknown;
    try {
      verifyRefundIntent({
        intent,
        publicKey: intruder.publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RefundAuthError);
    expect((captured as RefundAuthError).code).toBe("wallet_mismatch");
  });

  it("rejects an issuedAt outside the replay window", () => {
    const { publicKey, privateKey } = makeWallet();
    const stale = new Date(FIXED_NOW - 10 * 60 * 1000).toISOString();
    const intent = {
      paymentId: "pay_42",
      merchantWallet: publicKey,
      amount: 1,
      currency: "USDC",
      reason: "x",
      issuedAt: stale,
    };
    const message = buildRefundIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    let captured: unknown;
    try {
      verifyRefundIntent({ intent, publicKey, signature, now: FIXED_NOW });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RefundAuthError);
    expect((captured as RefundAuthError).code).toBe("issued_at_expired");
  });

  it("rejects when the amount is tampered with after signing", () => {
    const { publicKey, privateKey } = makeWallet();
    const original = {
      paymentId: "pay_42",
      merchantWallet: publicKey,
      amount: 25.5,
      currency: "USDC",
      reason: "x",
      issuedAt: ISSUED_AT,
    };
    const message = buildRefundIntentMessage(original);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    const tampered = { ...original, amount: 100 };
    let captured: unknown;
    try {
      verifyRefundIntent({
        intent: tampered,
        publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RefundAuthError);
    expect((captured as RefundAuthError).code).toBe("invalid_signature");
  });

  it("rejects when the reason is tampered with after signing", () => {
    const { publicKey, privateKey } = makeWallet();
    const original = {
      paymentId: "pay_42",
      merchantWallet: publicKey,
      amount: 25.5,
      currency: "USDC",
      reason: "fraud",
      issuedAt: ISSUED_AT,
    };
    const message = buildRefundIntentMessage(original);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    const tampered = { ...original, reason: "duplicate" };
    let captured: unknown;
    try {
      verifyRefundIntent({
        intent: tampered,
        publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RefundAuthError);
    expect((captured as RefundAuthError).code).toBe("invalid_signature");
  });

  it("rejects an invalid base58 public key", () => {
    const { privateKey } = makeWallet();
    const intent = {
      paymentId: "pay_42",
      merchantWallet: "0OIl",
      amount: 1,
      currency: "USDC",
      reason: "x",
      issuedAt: ISSUED_AT,
    };
    const message = buildRefundIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    let captured: unknown;
    try {
      verifyRefundIntent({
        intent,
        publicKey: "0OIl",
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(RefundAuthError);
    expect((captured as RefundAuthError).code).toBe("invalid_public_key");
  });
});
