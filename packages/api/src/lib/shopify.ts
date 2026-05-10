import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Shopify shop domains are always `<store>.myshopify.com`. Anything else is
 * rejected before we hand it off to OAuth — a wildcard host check here is the
 * only reason a hostile redirect to attacker.com isn't reachable from /install.
 */
const SHOP_DOMAIN_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export const SHOPIFY_HMAC_HEADER = "x-shopify-hmac-sha256";
export const SHOPIFY_SHOP_DOMAIN_HEADER = "x-shopify-shop-domain";

export type ShopifyHmacFailure =
  | "missing_hmac"
  | "missing_secret"
  | "invalid_hmac";

export type ShopifyHmacResult =
  | { valid: true }
  | { valid: false; reason: ShopifyHmacFailure };

export function isValidShopDomain(domain: string): boolean {
  return SHOP_DOMAIN_RE.test(domain);
}

export function normalizeShopDomain(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!isValidShopDomain(trimmed)) return null;
  return trimmed;
}

/**
 * Verify the `hmac` query parameter Shopify attaches to OAuth redirects and
 * iframe loads. Per Shopify spec: drop `hmac` and `signature`, sort the rest
 * alphabetically, join `k=v` with `&`, then HMAC-SHA256 with the app secret.
 */
export function verifyShopifyOAuthHmac(
  params: Record<string, string | string[] | undefined>,
  secret: string,
): ShopifyHmacResult {
  if (!secret) return { valid: false, reason: "missing_secret" };

  const provided = params.hmac;
  const hmacValue = Array.isArray(provided) ? provided[0] : provided;
  if (!hmacValue || typeof hmacValue !== "string") {
    return { valid: false, reason: "missing_hmac" };
  }

  const message = canonicalizeOAuthParams(params);
  const expected = createHmac("sha256", secret).update(message).digest("hex");

  return safeHexCompare(hmacValue, expected)
    ? { valid: true }
    : { valid: false, reason: "invalid_hmac" };
}

/**
 * Verify a Shopify webhook signature. Webhooks ship the HMAC in a header and
 * the secret signs the raw request body, base64-encoded.
 */
export function verifyShopifyWebhookHmac(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
): ShopifyHmacResult {
  if (!secret) return { valid: false, reason: "missing_secret" };
  if (!signatureHeader) return { valid: false, reason: "missing_hmac" };

  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  const expected = createHmac("sha256", secret).update(body).digest("base64");

  return safeBase64Compare(signatureHeader, expected)
    ? { valid: true }
    : { valid: false, reason: "invalid_hmac" };
}

function canonicalizeOAuthParams(
  params: Record<string, string | string[] | undefined>,
): string {
  const entries: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(params)) {
    if (key === "hmac" || key === "signature") continue;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const v of value) entries.push([key, v]);
    } else {
      entries.push([key, value]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}=${v}`).join("&");
}

function safeHexCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

function safeBase64Compare(a: string, b: string): boolean {
  try {
    const ab = Buffer.from(a, "base64");
    const bb = Buffer.from(b, "base64");
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
