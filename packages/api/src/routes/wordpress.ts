import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import {
  renderWordPressShortcode,
  WORDPRESS_PLUGIN_SLUG,
} from "../lib/wordpress.js";

export interface WordPressRouterOptions {
  /** Public origin the shortcode buttons should redirect checkouts to. */
  publicAppUrl?: string;
  /** Plugin version exposed to merchants — keep in sync with plugins/wordpress-zettapay. */
  pluginVersion?: string;
}

const DEFAULT_PLUGIN_VERSION = "0.1.0";

/**
 * Onboarding endpoints for the generic WordPress (non-Woo) plugin. The plugin
 * itself lives at `plugins/wordpress-zettapay/` and renders a `[zettapay]`
 * shortcode. These routes feed the dashboard's install instructions.
 */
export function wordpressRouter(db: Db, options: WordPressRouterOptions = {}): Router {
  const router = Router();
  const version = options.pluginVersion ?? DEFAULT_PLUGIN_VERSION;

  router.get("/wordpress/plugin/info", (_req: Request, res: Response) => {
    res.json({
      slug: WORDPRESS_PLUGIN_SLUG,
      version,
      requires_wordpress: "6.0",
      requires_php: "7.4",
      shortcode: {
        tag: "zettapay",
        attribute: "merchant",
        example: '[zettapay merchant="merch_xxx" amount="10.00"]',
        supported_attributes: [
          "merchant",
          "amount",
          "currency",
          "label",
          "order_ref",
          "success_url",
          "cancel_url",
          "modal",
        ],
      },
      install_steps: [
        "Upload the plugin zip to wp-admin → Plugins → Add New",
        "Activate the plugin and open Settings → ZettaPay",
        "Paste your Merchant ID from the ZettaPay dashboard and save",
        'Insert [zettapay] in any page or post — or override per-shortcode: [zettapay merchant="merch_xxx" amount="10.00"]',
      ],
    });
  });

  router.get(
    "/wordpress/plugin/info/:merchantId",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const merchantId = String(req.params.merchantId ?? "");
        const merchant = findMerchantById(db, merchantId);
        if (!merchant) {
          throw HttpError.notFound(`Merchant ${merchantId} not found`);
        }
        const base = (options.publicAppUrl ?? "").replace(/\/+$/, "");
        const snippet = renderWordPressShortcode({
          merchantId: merchant.id,
          merchantName: merchant.name,
          sampleAmount: "10.00",
        });
        res.json({
          slug: WORDPRESS_PLUGIN_SLUG,
          version,
          merchant: {
            id: merchant.id,
            name: merchant.name,
          },
          shortcode: {
            tag: "zettapay",
            snippet,
          },
          api: {
            base_url: base || null,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
