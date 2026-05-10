import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import {
  renderWebflowEmbedScript,
  renderWebflowEmbedSnippet,
} from "../lib/webflow.js";

export interface WebflowRouterOptions {
  /** Public origin the embed script should redirect checkouts to. */
  publicAppUrl?: string;
  /** Build identifier baked into the served script for cache-busting. */
  buildId?: string;
}

const DEFAULT_BUILD_ID = "0.1.0";
const ONE_HOUR = 60 * 60;

/**
 * Webflow drop-in embed.
 *
 * Webflow merchants paste a single `<script>` tag into their site head; the
 * served IIFE walks the DOM for `[data-zettapay-merchant]` elements and turns
 * each into a USDC checkout button that opens a hosted ZettaPay checkout
 * modal. Per-merchant onboarding metadata lives at /webflow/snippet/:merchantId.
 */
export function webflowRouter(db: Db, options: WebflowRouterOptions = {}): Router {
  const router = Router();
  const buildId = options.buildId ?? DEFAULT_BUILD_ID;

  router.get("/webflow/embed.js", (req: Request, res: Response) => {
    const payBase = (options.publicAppUrl ?? `${req.protocol}://${req.get("host") ?? ""}`)
      .replace(/\/+$/, "");
    const body = renderWebflowEmbedScript({ payBase, buildId });
    res.set("content-type", "application/javascript; charset=utf-8");
    res.set("cache-control", `public, max-age=${ONE_HOUR}, immutable`);
    res.set("x-zettapay-build", buildId);
    res.status(200).send(body);
  });

  router.get(
    "/webflow/snippet/:merchantId",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const merchantId = String(req.params.merchantId ?? "");
        const merchant = findMerchantById(db, merchantId);
        if (!merchant) {
          throw HttpError.notFound(`Merchant ${merchantId} not found`);
        }
        const base = (options.publicAppUrl ?? `${req.protocol}://${req.get("host") ?? ""}`)
          .replace(/\/+$/, "");
        const html = renderWebflowEmbedSnippet({
          merchantId: merchant.id,
          merchantName: merchant.name,
          scriptUrl: `${base}/webflow/embed.js`,
        });
        res.set("content-type", "text/html; charset=utf-8");
        res.set("cache-control", "public, max-age=300");
        res.status(200).send(html);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/webflow/plugin/info",
    (_req: Request, res: Response) => {
      res.json({
        slug: "zettapay-webflow-embed",
        version: buildId,
        embed: {
          attribute: "data-zettapay-merchant",
          script_path: "/webflow/embed.js",
          snippet_path: "/webflow/snippet/<merchantId>",
        },
        install_steps: [
          "Open your Webflow project → Site settings → Custom code",
          "Paste <script src=\"<api-base>/webflow/embed.js\" defer></script> into the Head Code field",
          "Add an Embed element where the checkout button should appear and paste the snippet from /webflow/snippet/<merchantId>",
          "Edit data-zettapay-amount per page (or bind it to a CMS field) before publishing",
        ],
      });
    },
  );

  return router;
}
