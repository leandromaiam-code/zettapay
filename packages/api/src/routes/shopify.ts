import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { findInstallationByShopDomain } from "../db/shopify.js";
import { HttpError } from "../lib/errors.js";
import { isValidShopDomain } from "../lib/shopify.js";
import {
  beginInstall,
  completeInstall,
  defaultTokenExchanger,
  type ShopifyAppConfig,
  type ShopifyTokenExchanger,
} from "../services/shopify.js";

export interface ShopifyRouterOptions {
  /** When null, OAuth routes return 503 — snippet routes still work. */
  config: ShopifyAppConfig | null;
  /** Test seam — production uses defaultTokenExchanger. */
  exchangeToken?: ShopifyTokenExchanger;
  /** Public origin used to build the storefront pay URL the snippet links to. */
  publicAppUrl?: string;
}

const SHOP_DOMAIN_MAX_LEN = 253;

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => unknown>(
  fn: T,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function requireConfig(config: ShopifyAppConfig | null): ShopifyAppConfig {
  if (!config) {
    throw new HttpError(
      503,
      "config_error",
      "Shopify app credentials not configured",
    );
  }
  return config;
}

export function shopifyRouter(db: Db, options: ShopifyRouterOptions): Router {
  const router = Router();
  const exchangeToken = options.exchangeToken ?? defaultTokenExchanger;

  router.get("/shopify/install", (req, res, next) => {
    try {
      const config = requireConfig(options.config);
      const shop = readQuery(req, "shop", SHOP_DOMAIN_MAX_LEN);
      const merchantId = readQuery(req, "merchant_id", 64);

      const { authorizeUrl } = beginInstall(db, config, {
        shopDomain: shop,
        merchantId,
      });
      res.redirect(302, authorizeUrl);
    } catch (err) {
      next(err);
    }
  });

  router.get(
    "/shopify/callback",
    asyncHandler(async (req, res) => {
      const config = requireConfig(options.config);
      const installation = await completeInstall(db, config, { exchangeToken }, {
        query: req.query as Record<string, string | string[] | undefined>,
      });
      res.status(200).json({
        ok: true,
        installation: {
          id: installation.id,
          shopDomain: installation.shopDomain,
          merchantId: installation.merchantId,
          status: installation.status,
          installedAt: installation.installedAt,
        },
      });
    }),
  );

  router.get("/shopify/snippet/:merchantId.liquid", (req, res, next) => {
    try {
      const merchantId = String(req.params.merchantId ?? "");
      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }
      const liquid = renderCheckoutSnippet({
        merchantId: merchant.id,
        merchantName: merchant.name,
        publicAppUrl: options.publicAppUrl ?? options.config?.appUrl ?? "",
      });
      res.set("content-type", "application/liquid; charset=utf-8");
      res.set("cache-control", "public, max-age=300");
      res.status(200).send(liquid);
    } catch (err) {
      next(err);
    }
  });

  router.get("/shopify/installations/:shopDomain", (req, res, next) => {
    try {
      const shopDomain = String(req.params.shopDomain ?? "").toLowerCase();
      if (!isValidShopDomain(shopDomain)) {
        throw HttpError.badRequest(
          `Path param must be a valid <store>.myshopify.com domain`,
        );
      }
      const installation = findInstallationByShopDomain(db, shopDomain);
      if (!installation) {
        throw HttpError.notFound(`Installation for ${shopDomain} not found`);
      }
      res.json({
        installation: {
          id: installation.id,
          shopDomain: installation.shopDomain,
          merchantId: installation.merchantId,
          status: installation.status,
          scope: installation.scope,
          installedAt: installation.installedAt,
          uninstalledAt: installation.uninstalledAt,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

function readQuery(req: Request, name: string, maxLen: number): string {
  const raw = req.query[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length === 0) {
    throw HttpError.badRequest(`Query param "${name}" is required`);
  }
  if (value.length > maxLen) {
    throw HttpError.badRequest(`Query param "${name}" exceeds max length`);
  }
  return value;
}

interface RenderSnippetInput {
  merchantId: string;
  merchantName: string;
  publicAppUrl: string;
}

/**
 * Liquid snippet a Shopify merchant can drop into their checkout/cart theme
 * to render a "Pagar com ZettaPay" button. The snippet posts the cart total
 * to the ZettaPay storefront pay URL where the buyer signs the transaction.
 *
 * Liquid `{{ … }}` is left intact — Shopify's renderer fills it in when the
 * theme renders. The {merchantId} placeholder is interpolated server-side.
 */
function renderCheckoutSnippet(input: RenderSnippetInput): string {
  const { merchantId, merchantName, publicAppUrl } = input;
  const sanitizedName = escapeLiquid(merchantName);
  const payBase = publicAppUrl.replace(/\/+$/, "") || "";

  return [
    `{%- comment -%}`,
    `  ZettaPay checkout button — drop this snippet into your cart or`,
    `  checkout template via {% render 'zettapay-button' %}.`,
    `  Pagamentos USDC liquidados em segundos via Solana.`,
    `{%- endcomment -%}`,
    ``,
    `<div class="zettapay-button" data-merchant-id="${merchantId}" data-merchant-name="${sanitizedName}">`,
    `  <a`,
    `    class="zettapay-button__link"`,
    `    href="${payBase}/pay/checkout?merchant=${merchantId}&amount={{ cart.total_price | divided_by: 100.0 }}&currency={{ cart.currency.iso_code }}&order_ref={{ cart.token }}"`,
    `    rel="noopener"`,
    `    target="_top"`,
    `  >`,
    `    <span class="zettapay-button__brand">ZettaPay</span>`,
    `    <span class="zettapay-button__label">Pagar com USDC</span>`,
    `    <span class="zettapay-button__amount">{{ cart.total_price | money }}</span>`,
    `  </a>`,
    `</div>`,
    ``,
    `<style>`,
    `  .zettapay-button { margin: 12px 0; }`,
    `  .zettapay-button__link {`,
    `    display: inline-flex; align-items: center; gap: 12px;`,
    `    padding: 12px 20px; border-radius: 10px;`,
    `    background: #0a1612; color: #f5e6c8;`,
    `    font-family: 'Manrope', system-ui, sans-serif;`,
    `    text-decoration: none; transition: transform .15s ease;`,
    `  }`,
    `  .zettapay-button__link:hover { transform: translateY(-1px); }`,
    `  .zettapay-button__brand {`,
    `    font-family: 'Cinzel', serif; font-weight: 600;`,
    `    color: #d4a961; letter-spacing: .12em; text-transform: uppercase;`,
    `  }`,
    `  .zettapay-button__amount { opacity: .85; font-variant-numeric: tabular-nums; }`,
    `</style>`,
    ``,
  ].join("\n");
}

function escapeLiquid(s: string): string {
  return s.replace(/[<>"'&]/g, (c) => {
    switch (c) {
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "&":
        return "&amp;";
      default:
        return c;
    }
  });
}
