import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  mapSumsubReview,
  verifySumsubWebhook,
} from "../src/services/kyc/sumsub.js";

const SECRET = "whsec_sumsub_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function digest(secret: string, body: Buffer, alg: "sha1" | "sha256" = "sha256") {
  return createHmac(alg, secret).update(body).digest("hex");
}

describe("verifySumsubWebhook", () => {
  it("accepts a valid HMAC_SHA256_HEX signature", () => {
    const body = Buffer.from(JSON.stringify({ type: "applicantReviewed" }));
    const headers = {
      "x-payload-digest": digest(SECRET, body),
      "x-payload-digest-alg": "HMAC_SHA256_HEX",
    };
    const result = verifySumsubWebhook({ rawBody: body, headers, secret: SECRET });
    expect(result.valid).toBe(true);
  });

  it("accepts HMAC_SHA1_HEX (legacy tenants)", () => {
    const body = Buffer.from('{"type":"applicantPending"}');
    const headers = {
      "x-payload-digest": digest(SECRET, body, "sha1"),
      "x-payload-digest-alg": "HMAC_SHA1_HEX",
    };
    const result = verifySumsubWebhook({ rawBody: body, headers, secret: SECRET });
    expect(result.valid).toBe(true);
  });

  it("defaults to HMAC_SHA256_HEX when alg header is absent", () => {
    const body = Buffer.from("{}");
    const result = verifySumsubWebhook({
      rawBody: body,
      headers: { "x-payload-digest": digest(SECRET, body) },
      secret: SECRET,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = Buffer.from('{"type":"applicantReviewed"}');
    const sig = digest(SECRET, body);
    const tampered = Buffer.from('{"type":"applicantReviewed!"}');
    const result = verifySumsubWebhook({
      rawBody: tampered,
      headers: { "x-payload-digest": sig, "x-payload-digest-alg": "HMAC_SHA256_HEX" },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("signature_mismatch");
  });

  it("rejects a wrong secret", () => {
    const body = Buffer.from('{"x":1}');
    const result = verifySumsubWebhook({
      rawBody: body,
      headers: { "x-payload-digest": digest("other-secret", body) },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects when the digest header is missing", () => {
    const body = Buffer.from("{}");
    const result = verifySumsubWebhook({ rawBody: body, headers: {}, secret: SECRET });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_digest");
  });

  it("rejects an unsupported alg", () => {
    const body = Buffer.from("{}");
    const result = verifySumsubWebhook({
      rawBody: body,
      headers: {
        "x-payload-digest": "deadbeef",
        "x-payload-digest-alg": "MD5",
      },
      secret: SECRET,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("unsupported_alg");
  });
});

describe("mapSumsubReview", () => {
  it("maps GREEN applicantReviewed to approved", () => {
    const verdict = mapSumsubReview({
      type: "applicantReviewed",
      reviewResult: { reviewAnswer: "GREEN" },
    });
    expect(verdict.status).toBe("approved");
    expect(verdict.reviewAnswer).toBe("GREEN");
  });

  it("maps RED + RETRY to rejected", () => {
    const verdict = mapSumsubReview({
      type: "applicantReviewed",
      reviewResult: {
        reviewAnswer: "RED",
        reviewRejectType: "RETRY",
        moderationComment: "blurry photo",
      },
    });
    expect(verdict.status).toBe("rejected");
    expect(verdict.reviewReason).toBe("blurry photo");
  });

  it("maps RED + FINAL to blocked", () => {
    const verdict = mapSumsubReview({
      type: "applicantReviewed",
      reviewResult: {
        reviewAnswer: "RED",
        reviewRejectType: "FINAL",
        rejectLabels: ["FORGERY"],
      },
    });
    expect(verdict.status).toBe("blocked");
    expect(verdict.reviewReason).toBe("FORGERY");
  });

  it("maps applicantPending to in_review", () => {
    const verdict = mapSumsubReview({ type: "applicantPending" });
    expect(verdict.status).toBe("in_review");
  });

  it("falls back to pending on unknown types", () => {
    const verdict = mapSumsubReview({ type: "applicantSomethingElse" });
    expect(verdict.status).toBe("pending");
  });
});
