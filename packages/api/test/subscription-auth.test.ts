import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";
import {
  SUBSCRIPTION_AUTH_SCHEMA_VERSION,
  SubscriptionAuthError,
  buildAuthorizationMessage,
  verifySubscriptionAuthorization,
} from "../src/lib/subscription-auth.js";

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

const baseBinding = {
  subscriptionId: "sub_test_1",
  merchantId: "mer_test_1",
  customerWallet: "",
  amount: 9.99,
  currency: "USDC",
  interval: "monthly",
};

describe("subscription-auth / canonical message", () => {
  it("emits a stable schema header", () => {
    expect(SUBSCRIPTION_AUTH_SCHEMA_VERSION).toBe(
      "ZETTAPAY-SUBSCRIPTION-AUTH-V1",
    );
  });

  it("builds a canonical message with deterministic ordering", () => {
    const msg = buildAuthorizationMessage({
      subscriptionId: "sub_1",
      merchantId: "mer_1",
      customerWallet: "WALLET",
      amount: 12.5,
      currency: "USDC",
      interval: "weekly",
    }).toString("utf8");
    expect(msg).toBe(
      [
        SUBSCRIPTION_AUTH_SCHEMA_VERSION,
        "subscriptionId=sub_1",
        "merchantId=mer_1",
        "customerWallet=WALLET",
        "amount=12.5",
        "currency=USDC",
        "interval=weekly",
      ].join("\n"),
    );
  });
});

describe("subscription-auth / verify", () => {
  it("accepts a signature produced over the canonical binding", () => {
    const { publicKey, privateKey } = makeWallet();
    const binding = { ...baseBinding, customerWallet: publicKey };
    const message = buildAuthorizationMessage(binding);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    expect(() =>
      verifySubscriptionAuthorization({ binding, publicKey, signature }),
    ).not.toThrow();
  });

  it("rejects when the publicKey does not match the customer wallet", () => {
    const owner = makeWallet();
    const intruder = makeWallet();
    const binding = { ...baseBinding, customerWallet: owner.publicKey };
    const message = buildAuthorizationMessage(binding);
    const signature = bs58.encode(cryptoSign(null, message, intruder.privateKey));
    let captured: unknown;
    try {
      verifySubscriptionAuthorization({
        binding,
        publicKey: intruder.publicKey,
        signature,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionAuthError);
    expect((captured as SubscriptionAuthError).code).toBe("wallet_mismatch");
  });

  it("rejects when the binding has been tampered with after signing", () => {
    const { publicKey, privateKey } = makeWallet();
    const original = { ...baseBinding, customerWallet: publicKey, amount: 9.99 };
    const message = buildAuthorizationMessage(original);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    const tampered = { ...original, amount: 999 };
    let captured: unknown;
    try {
      verifySubscriptionAuthorization({
        binding: tampered,
        publicKey,
        signature,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionAuthError);
    expect((captured as SubscriptionAuthError).code).toBe("invalid_signature");
  });

  it("rejects malformed public keys", () => {
    let captured: unknown;
    try {
      verifySubscriptionAuthorization({
        binding: { ...baseBinding, customerWallet: "not-base58!@#" },
        publicKey: "not-base58!@#",
        signature: bs58.encode(Buffer.alloc(64, 0)),
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionAuthError);
    expect((captured as SubscriptionAuthError).code).toBe("invalid_public_key");
  });

  it("rejects malformed signatures", () => {
    const { publicKey } = makeWallet();
    let captured: unknown;
    try {
      verifySubscriptionAuthorization({
        binding: { ...baseBinding, customerWallet: publicKey },
        publicKey,
        signature: "not-base58!@#",
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionAuthError);
    expect((captured as SubscriptionAuthError).code).toBe("invalid_signature");
  });
});
