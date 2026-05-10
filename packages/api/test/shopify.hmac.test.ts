import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import {
  isValidShopDomain,
  normalizeShopDomain,
  verifyShopifyOAuthHmac,
  verifyShopifyWebhookHmac,
} from "../src/lib/shopify.js";

const SECRET = "shpss_test_secret_aaaaaaaaaaaaaaaaaaaa";

function signOAuth(params: Record<string, string>, secret: string): string {
  const msg = Object.entries(params)
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(msg).digest("hex");
}

describe("shopify shop domain validation", () => {
  it("accepts canonical *.myshopify.com domains", () => {
    expect(isValidShopDomain("acme.myshopify.com")).toBe(true);
    expect(isValidShopDomain("acme-store-1.myshopify.com")).toBe(true);
    expect(normalizeShopDomain("  Acme.MyShopify.com  ")).toBe(
      "acme.myshopify.com",
    );
  });

  it("rejects non-Shopify hosts and malformed inputs", () => {
    expect(isValidShopDomain("attacker.com")).toBe(false);
    expect(isValidShopDomain("acme.myshopify.com.attacker.com")).toBe(false);
    expect(isValidShopDomain("https://acme.myshopify.com")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
    expect(normalizeShopDomain("not-a-shop")).toBeNull();
  });
});

describe("verifyShopifyOAuthHmac", () => {
  it("accepts a correctly signed callback", () => {
    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "abc123",
      state: "nonce_xyz",
      timestamp: "1700000000",
    };
    const hmac = signOAuth(params, SECRET);
    const result = verifyShopifyOAuthHmac({ ...params, hmac }, SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects when hmac is missing", () => {
    const result = verifyShopifyOAuthHmac(
      { shop: "acme.myshopify.com", code: "x" },
      SECRET,
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_hmac");
  });

  it("rejects when secret is missing", () => {
    const result = verifyShopifyOAuthHmac(
      { shop: "acme.myshopify.com", hmac: "deadbeef" },
      "",
    );
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_secret");
  });

  it("rejects a tampered query param", () => {
    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "abc",
      state: "nonce",
      timestamp: "1700000000",
    };
    const hmac = signOAuth(params, SECRET);
    const tampered = { ...params, code: "abc-tampered", hmac };
    const result = verifyShopifyOAuthHmac(tampered, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("invalid_hmac");
  });

  it("rejects when signed with the wrong secret", () => {
    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "abc",
      state: "nonce",
    };
    const hmac = signOAuth(params, "wrong-secret");
    const result = verifyShopifyOAuthHmac({ ...params, hmac }, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("invalid_hmac");
  });

  it("ignores `signature` per Shopify spec", () => {
    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "abc",
    };
    const hmac = signOAuth(params, SECRET);
    const result = verifyShopifyOAuthHmac(
      { ...params, hmac, signature: "should-be-ignored" },
      SECRET,
    );
    expect(result.valid).toBe(true);
  });
});

describe("verifyShopifyWebhookHmac", () => {
  it("accepts a correctly signed body", () => {
    const body = JSON.stringify({ id: 12345, kind: "orders/paid" });
    const expected = createHmac("sha256", SECRET).update(body).digest("base64");
    const result = verifyShopifyWebhookHmac(body, expected, SECRET);
    expect(result.valid).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = JSON.stringify({ id: 1 });
    const expected = createHmac("sha256", SECRET).update(body).digest("base64");
    const result = verifyShopifyWebhookHmac(`${body} `, expected, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("invalid_hmac");
  });

  it("rejects when header is missing", () => {
    const result = verifyShopifyWebhookHmac("body", undefined, SECRET);
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("missing_hmac");
  });
});
