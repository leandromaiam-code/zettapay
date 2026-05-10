import { randomBytes } from "node:crypto";
import type { Database as Db } from "better-sqlite3";
import {
  completeInstallation,
  findInstallationByShopDomain,
  upsertPendingInstallation,
  type ShopifyInstallation,
} from "../db/shopify.js";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import { newId } from "../lib/id.js";
import {
  isValidShopDomain,
  normalizeShopDomain,
  verifyShopifyOAuthHmac,
} from "../lib/shopify.js";

export interface ShopifyAppConfig {
  /** Public Shopify app client_id (Partners dashboard → API key). */
  apiKey: string;
  /** Shopify app shared secret. Signs OAuth callbacks and inbound webhooks. */
  apiSecret: string;
  /** Comma-separated scopes requested at install. */
  scopes: string;
  /** Public origin of the ZettaPay API (used to build redirect_uri). */
  appUrl: string;
}

export interface TokenExchangeResponse {
  access_token: string;
  scope: string;
}

export type ShopifyTokenExchanger = (input: {
  shopDomain: string;
  code: string;
  apiKey: string;
  apiSecret: string;
}) => Promise<TokenExchangeResponse>;

export interface ShopifyServiceDeps {
  config: ShopifyAppConfig | null;
  exchangeToken?: ShopifyTokenExchanger;
}

const NONCE_BYTES = 24;

export interface BeginInstallInput {
  shopDomain: string;
  merchantId: string;
}

export interface BeginInstallResult {
  installation: ShopifyInstallation;
  authorizeUrl: string;
}

/**
 * Step 1 of OAuth: persist a pending installation with a fresh nonce and
 * return the Shopify authorize URL the merchant must be redirected to.
 */
export function beginInstall(
  db: Db,
  config: ShopifyAppConfig,
  input: BeginInstallInput,
): BeginInstallResult {
  const shopDomain = normalizeShopDomain(input.shopDomain);
  if (!shopDomain) {
    throw HttpError.badRequest(
      `"shop" must be a valid <store>.myshopify.com domain`,
    );
  }
  const merchant = findMerchantById(db, input.merchantId);
  if (!merchant) {
    throw HttpError.notFound(`Merchant ${input.merchantId} not found`);
  }

  const nonce = randomBytes(NONCE_BYTES).toString("hex");
  const installation = upsertPendingInstallation(db, {
    id: newId("shop"),
    shopDomain,
    merchantId: merchant.id,
    oauthNonce: nonce,
  });

  const redirectUri = buildRedirectUri(config.appUrl);
  const url = new URL(`https://${shopDomain}/admin/oauth/authorize`);
  url.searchParams.set("client_id", config.apiKey);
  url.searchParams.set("scope", config.scopes);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", nonce);

  return { installation, authorizeUrl: url.toString() };
}

export interface CompleteInstallInput {
  query: Record<string, string | string[] | undefined>;
}

/**
 * Step 2 of OAuth: validate the callback HMAC + state, exchange the temporary
 * code for a permanent access_token, and mark the installation complete.
 */
export async function completeInstall(
  db: Db,
  config: ShopifyAppConfig,
  deps: { exchangeToken: ShopifyTokenExchanger },
  input: CompleteInstallInput,
): Promise<ShopifyInstallation> {
  const { query } = input;
  const verification = verifyShopifyOAuthHmac(query, config.apiSecret);
  if (!verification.valid) {
    throw HttpError.unauthorized(`Shopify HMAC validation failed: ${verification.reason}`);
  }

  const shopRaw = firstString(query.shop);
  const code = firstString(query.code);
  const state = firstString(query.state);

  if (!shopRaw || !isValidShopDomain(shopRaw)) {
    throw HttpError.badRequest(`"shop" must be a valid <store>.myshopify.com domain`);
  }
  if (!code) throw HttpError.badRequest(`"code" is required`);
  if (!state) throw HttpError.badRequest(`"state" is required`);

  const pending = findInstallationByShopDomain(db, shopRaw);
  if (!pending || pending.oauthNonce !== state) {
    throw HttpError.unauthorized(`OAuth state mismatch`);
  }

  const tokenResponse = await deps.exchangeToken({
    shopDomain: shopRaw,
    code,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
  });

  const completed = completeInstallation(db, {
    shopDomain: shopRaw,
    accessToken: tokenResponse.access_token,
    scope: tokenResponse.scope,
    expectedNonce: state,
  });
  if (!completed) {
    throw HttpError.unauthorized(`OAuth state mismatch`);
  }
  return completed;
}

/**
 * Default token exchanger calls Shopify's `/admin/oauth/access_token` endpoint
 * over HTTPS. Tests inject a fake exchanger to avoid network I/O.
 */
export const defaultTokenExchanger: ShopifyTokenExchanger = async ({
  shopDomain,
  code,
  apiKey,
  apiSecret,
}) => {
  const res = await fetch(`https://${shopDomain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: apiKey,
      client_secret: apiSecret,
      code,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw HttpError.upstream(
      `Shopify token exchange failed: ${res.status}`,
      detail || undefined,
    );
  }
  const json = (await res.json()) as Partial<TokenExchangeResponse>;
  if (!json.access_token || !json.scope) {
    throw HttpError.upstream("Shopify token response missing fields");
  }
  return { access_token: json.access_token, scope: json.scope };
};

function firstString(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.length > 0 ? first : null;
  }
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

function buildRedirectUri(appUrl: string): string {
  const base = appUrl.replace(/\/+$/, "");
  return `${base}/shopify/callback`;
}
