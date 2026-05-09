import { describe, it, expect } from "vitest";
import {
  signWebhookPayload,
  verifyWebhookSignature,
} from "../src/lib/webhook-signature.js";

const SECRET = "whsec_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PAYLOAD = JSON.stringify({ event: "payment.completed", id: "pay_1" });

describe("webhook signature", () => {
  it("signs and verifies a payload roundtrip", () => {
    const ts = Date.now();
    const sig = signWebhookPayload({ secret: SECRET, payload: PAYLOAD, timestamp: ts });
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);

    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      timestamp: ts,
      signature: sig,
      now: () => ts,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered payload", () => {
    const ts = Date.now();
    const sig = signWebhookPayload({ secret: SECRET, payload: PAYLOAD, timestamp: ts });
    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD + "x",
      timestamp: ts,
      signature: sig,
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a wrong secret", () => {
    const ts = Date.now();
    const sig = signWebhookPayload({ secret: SECRET, payload: PAYLOAD, timestamp: ts });
    const result = verifyWebhookSignature({
      secret: "whsec_wrong",
      payload: PAYLOAD,
      timestamp: ts,
      signature: sig,
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects timestamps outside the tolerance window", () => {
    const ts = Date.now();
    const sig = signWebhookPayload({ secret: SECRET, payload: PAYLOAD, timestamp: ts });
    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      timestamp: ts,
      signature: sig,
      now: () => ts + 10 * 60 * 1000,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("timestamp_out_of_tolerance");
  });

  it("rejects malformed signature header", () => {
    const ts = Date.now();
    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      timestamp: ts,
      signature: "sha256=not-hex",
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed_signature");
  });

  it("rejects missing signature", () => {
    const ts = Date.now();
    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      timestamp: ts,
      signature: "",
      now: () => ts,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_signature");
  });

  it("accepts signatures with or without the sha256= prefix", () => {
    const ts = Date.now();
    const sig = signWebhookPayload({ secret: SECRET, payload: PAYLOAD, timestamp: ts });
    const bare = sig.replace(/^sha256=/, "");
    const result = verifyWebhookSignature({
      secret: SECRET,
      payload: PAYLOAD,
      timestamp: ts,
      signature: bare,
      now: () => ts,
    });
    expect(result.valid).toBe(true);
  });
});
