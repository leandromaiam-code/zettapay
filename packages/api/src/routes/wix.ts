import { Router, type Request, type Response, type NextFunction } from "express";
import type { Database as Db } from "better-sqlite3";
import { findMerchantById } from "../db/merchants.js";
import { HttpError } from "../lib/errors.js";
import {
  WIX_APP_SLUG,
  renderWixAppManifest,
  renderWixVeloBackendModule,
  renderWixVeloPageModule,
} from "../lib/wix.js";

export interface WixRouterOptions {
  /** Public origin the Velo modules and manifest should reference. */
  publicAppUrl?: string;
  /** Build identifier baked into served modules and the manifest. */
  buildId?: string;
}

const DEFAULT_BUILD_ID = "0.1.0";
const FIVE_MINUTES = 5 * 60;

/**
 * Wix App Market submission + Velo integration.
 *
 * Surfaces three things:
 *   - GET /wix/manifest.json           the static App Market manifest
 *   - GET /wix/velo/backend/:merchant  per-merchant Velo backend module
 *   - GET /wix/velo/page               page-level Velo script (merchant-agnostic)
 *   - GET /wix/app/info                onboarding metadata for the dashboard
 */
export function wixRouter(db: Db, options: WixRouterOptions = {}): Router {
  const router = Router();
  const buildId = options.buildId ?? DEFAULT_BUILD_ID;

  function resolveBase(req: Request): string {
    const fallback = `${req.protocol}://${req.get("host") ?? ""}`;
    return (options.publicAppUrl ?? fallback).replace(/\/+$/, "");
  }

  router.get("/wix/manifest.json", (req: Request, res: Response) => {
    const manifest = renderWixAppManifest({
      apiBase: resolveBase(req),
      buildId,
    });
    res.set("content-type", "application/json; charset=utf-8");
    res.set("cache-control", `public, max-age=${FIVE_MINUTES}`);
    res.set("x-zettapay-build", buildId);
    res.status(200).json(manifest);
  });

  router.get(
    "/wix/velo/backend/:merchantId",
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const merchantId = String(req.params.merchantId ?? "");
        const merchant = findMerchantById(db, merchantId);
        if (!merchant) {
          throw HttpError.notFound(`Merchant ${merchantId} not found`);
        }
        const base = resolveBase(req);
        const body = renderWixVeloBackendModule({
          apiBase: base,
          payBase: base,
          buildId,
          merchantId: merchant.id,
        });
        res.set("content-type", "application/javascript; charset=utf-8");
        res.set("cache-control", `public, max-age=${FIVE_MINUTES}`);
        res.set("x-zettapay-build", buildId);
        res.set(
          "content-disposition",
          `attachment; filename="zettapay.web.js"`,
        );
        res.status(200).send(body);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get("/wix/velo/page", (_req: Request, res: Response) => {
    const body = renderWixVeloPageModule({ buildId });
    res.set("content-type", "application/javascript; charset=utf-8");
    res.set("cache-control", `public, max-age=${FIVE_MINUTES}`);
    res.set("x-zettapay-build", buildId);
    res.set(
      "content-disposition",
      `attachment; filename="zettapay-checkout.js"`,
    );
    res.status(200).send(body);
  });

  router.get("/wix/app/info", (_req: Request, res: Response) => {
    res.json({
      slug: WIX_APP_SLUG,
      version: buildId,
      submission: {
        manifest_path: "/wix/manifest.json",
      },
      velo: {
        backend_module_path: "/wix/velo/backend/<merchantId>",
        page_module_path: "/wix/velo/page",
        backend_filename: "zettapay.web.js",
        page_filename: "zettapay-checkout.js",
      },
      install_steps: [
        "Open your Wix site → Dev Mode → enable Velo by Wix",
        "Create backend/zettapay.web.js and paste the contents of /wix/velo/backend/<merchantId>",
        "Add a Lightbox named zettapay-checkout containing an HTML iframe bound to the URL prop",
        "On the page where checkout should appear, add a Button (#zpPayButton) and paste /wix/velo/page into the page code",
        "Preview, run a test payment, and submit your app via the Wix App Market dashboard using /wix/manifest.json",
      ],
    });
  });

  return router;
}
