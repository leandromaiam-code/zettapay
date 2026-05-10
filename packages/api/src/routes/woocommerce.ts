import { Router, type Request, type Response } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";

export interface WooCommerceRouterOptions {
  /** Public origin a merchant should configure as their webhook destination prefix. */
  publicAppUrl?: string;
  /** Plugin version exposed to merchants — keep in sync with plugins/woocommerce-zettapay. */
  pluginVersion?: string;
}

const DEFAULT_PLUGIN_VERSION = "0.1.0";
const PLUGIN_SLUG = "zettapay-for-woocommerce";

/**
 * The WooCommerce integration is shipped as a self-hosted PHP plugin
 * (`plugins/woocommerce-zettapay`). This router exposes the merchant-facing
 * onboarding metadata: which version is current, what URL their store should
 * send webhooks to, and the per-merchant webhook signing secret they need to
 * paste into the plugin's settings page.
 */
export function woocommerceRouter(db: Db, options: WooCommerceRouterOptions = {}): Router {
  const router = Router();
  const version = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;

  router.get("/woocommerce/plugin/info", (_req: Request, res: Response) => {
    res.json({
      slug: PLUGIN_SLUG,
      version,
      requires_woocommerce: "7.0",
      requires_php: "7.4",
      signature: {
        algorithm: "hmac-sha256",
        signature_header: "X-ZettaPay-Signature",
        timestamp_header: "X-ZettaPay-Timestamp",
        event_id_header: "X-ZettaPay-Event-Id",
        tolerance_sec: 300,
        format: "sha256=<hex>",
        signed_payload: "<timestamp>.<raw_body>",
      },
      install_steps: [
        "Upload the plugin zip to wp-admin → Plugins → Add New",
        "Activate the plugin and open WooCommerce → Settings → Payments → ZettaPay",
        "Paste your Merchant ID and API key from the ZettaPay dashboard",
        "Copy the Webhook URL and signing secret shown in the gateway settings into the ZettaPay dashboard",
      ],
    });
  });

  router.get("/woocommerce/plugin/info/:merchantId", (req, res, next) => {
    try {
      const merchantId = String(req.params.merchantId ?? "");
      const merchant = findMerchantById(db, merchantId);
      if (!merchant) {
        throw HttpError.notFound(`Merchant ${merchantId} not found`);
      }

      const base = (options.publicAppUrl ?? "").replace(/\/+$/, "");
      res.json({
        slug: PLUGIN_SLUG,
        version,
        merchant: {
          id: merchant.id,
          name: merchant.name,
        },
        webhook: {
          // The merchant must configure their store-side webhook destination
          // separately (it lives on their WordPress install). What we hand
          // back here is the secret they should paste into the plugin so
          // signatures from our outbound dispatcher verify cleanly.
          configured_url: merchant.webhookUrl,
          signing_secret_present: Boolean(merchant.webhookSecret),
        },
        api: {
          base_url: base || null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
