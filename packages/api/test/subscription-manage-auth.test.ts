import { describe, it, expect } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";
import {
  SUBSCRIPTION_MANAGE_SCHEMA_VERSION,
  SubscriptionManageAuthError,
  buildManageIntentMessage,
  isSubscriptionManageAction,
  verifySubscriptionManageIntent,
} from "../src/lib/subscription-manage-auth.js";

function makeWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

const FIXED_NOW = new Date("2026-05-10T12:00:00.000Z").getTime();
const ISSUED_AT = new Date(FIXED_NOW).toISOString();

describe("subscription-manage-auth / canonical message", () => {
  it("emits a stable schema header", () => {
    expect(SUBSCRIPTION_MANAGE_SCHEMA_VERSION).toBe(
      "ZETTAPAY-SUBSCRIPTION-MANAGE-V1",
    );
  });

  it("isSubscriptionManageAction accepts the three canonical actions", () => {
    expect(isSubscriptionManageAction("cancel")).toBe(true);
    expect(isSubscriptionManageAction("pause")).toBe(true);
    expect(isSubscriptionManageAction("resume")).toBe(true);
    expect(isSubscriptionManageAction("delete")).toBe(false);
    expect(isSubscriptionManageAction(undefined)).toBe(false);
  });

  it("builds a deterministic intent message", () => {
    const msg = buildManageIntentMessage({
      action: "cancel",
      subscriptionId: "sub_1",
      customerWallet: "WALLET",
      issuedAt: ISSUED_AT,
    }).toString("utf8");
    expect(msg).toBe(
      [
        SUBSCRIPTION_MANAGE_SCHEMA_VERSION,
        "action=cancel",
        "subscriptionId=sub_1",
        "customerWallet=WALLET",
        `issuedAt=${ISSUED_AT}`,
      ].join("\n"),
    );
  });
});

describe("subscription-manage-auth / verify", () => {
  it("accepts a fresh, correctly-signed cancel intent", () => {
    const { publicKey, privateKey } = makeWallet();
    const intent = {
      action: "pause" as const,
      subscriptionId: "sub_42",
      customerWallet: publicKey,
      issuedAt: ISSUED_AT,
    };
    const message = buildManageIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    expect(() =>
      verifySubscriptionManageIntent({
        intent,
        publicKey,
        signature,
        now: FIXED_NOW,
      }),
    ).not.toThrow();
  });

  it("rejects when publicKey does not match customer wallet", () => {
    const owner = makeWallet();
    const intruder = makeWallet();
    const intent = {
      action: "cancel" as const,
      subscriptionId: "sub_42",
      customerWallet: owner.publicKey,
      issuedAt: ISSUED_AT,
    };
    const message = buildManageIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, intruder.privateKey));
    let captured: unknown;
    try {
      verifySubscriptionManageIntent({
        intent,
        publicKey: intruder.publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionManageAuthError);
    expect((captured as SubscriptionManageAuthError).code).toBe(
      "wallet_mismatch",
    );
  });

  it("rejects an issuedAt outside the replay window", () => {
    const { publicKey, privateKey } = makeWallet();
    const stale = new Date(FIXED_NOW - 10 * 60 * 1000).toISOString();
    const intent = {
      action: "cancel" as const,
      subscriptionId: "sub_42",
      customerWallet: publicKey,
      issuedAt: stale,
    };
    const message = buildManageIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    let captured: unknown;
    try {
      verifySubscriptionManageIntent({
        intent,
        publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionManageAuthError);
    expect((captured as SubscriptionManageAuthError).code).toBe(
      "issued_at_expired",
    );
  });

  it("rejects an issuedAt that is not a valid timestamp", () => {
    const { publicKey, privateKey } = makeWallet();
    const intent = {
      action: "cancel" as const,
      subscriptionId: "sub_42",
      customerWallet: publicKey,
      issuedAt: "not-a-date",
    };
    const message = buildManageIntentMessage(intent);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    let captured: unknown;
    try {
      verifySubscriptionManageIntent({
        intent,
        publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionManageAuthError);
    expect((captured as SubscriptionManageAuthError).code).toBe(
      "issued_at_invalid",
    );
  });

  it("rejects when the action field is tampered with after signing", () => {
    const { publicKey, privateKey } = makeWallet();
    const original = {
      action: "pause" as const,
      subscriptionId: "sub_42",
      customerWallet: publicKey,
      issuedAt: ISSUED_AT,
    };
    const message = buildManageIntentMessage(original);
    const signature = bs58.encode(cryptoSign(null, message, privateKey));
    const tampered = { ...original, action: "cancel" as const };
    let captured: unknown;
    try {
      verifySubscriptionManageIntent({
        intent: tampered,
        publicKey,
        signature,
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionManageAuthError);
    expect((captured as SubscriptionManageAuthError).code).toBe(
      "invalid_signature",
    );
  });

  it("rejects malformed signatures", () => {
    const { publicKey } = makeWallet();
    let captured: unknown;
    try {
      verifySubscriptionManageIntent({
        intent: {
          action: "cancel",
          subscriptionId: "sub_42",
          customerWallet: publicKey,
          issuedAt: ISSUED_AT,
        },
        publicKey,
        signature: "not-base58!@#",
        now: FIXED_NOW,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(SubscriptionManageAuthError);
    expect((captured as SubscriptionManageAuthError).code).toBe(
      "invalid_signature",
    );
  });
});
