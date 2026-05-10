import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  WIX_APP_SLUG,
  renderWixAppManifest,
  renderWixVeloBackendModule,
  renderWixVeloPageModule,
} from "../src/lib/wix.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in wix tests");
  },
} as unknown as SolanaService;

const SHOPIFY_CONFIG = {
  apiKey: "shpaa_test_key",
  apiSecret: "shpss_test_secret_aaaaaaaaaaaaaaaaaaaa",
  scopes: "read_orders,write_script_tags",
  appUrl: "https://api.zettapay.test",
};

interface Server {
  url: string;
  close: () => Promise<void>;
}

async function startApp(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

function makeMerchant(db: Db, overrides: Partial<{ name: string }> = {}) {
  return registerMerchant(db, {
    name: overrides.name ?? "Acme Coffee",
    walletAddress: Keypair.generate().publicKey.toBase58(),
    email: `wix-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: null,
  });
}

describe("Wix App Market submission", () => {
  let db: Db;
  let server: Server;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: dummySolana,
      shopify: SHOPIFY_CONFIG,
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("serves /wix/manifest.json with App Market fields and absolute URLs", async () => {
    const res = await fetch(`${server.url}/wix/manifest.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    expect(res.headers.get("x-zettapay-build")).toBeTruthy();
    const body = (await res.json()) as ReturnType<typeof renderWixAppManifest>;
    expect(body.slug).toBe(WIX_APP_SLUG);
    expect(body.name).toBe("ZettaPay");
    expect(body.permissions).toContain("wix.fetch.outbound");
    expect(body.components.some((c) => c.type === "velo_backend_module")).toBe(true);
    expect(body.components.some((c) => c.type === "lightbox")).toBe(true);
    expect(body.oauth.install_url).toBe("https://api.zettapay.test/wix/install");
    expect(body.oauth.redirect_uri).toBe("https://api.zettapay.test/wix/callback");
    expect(body.webhook.url).toBe("https://api.zettapay.test/wix/webhook");
    expect(body.webhook.events).toContain("payment.completed");
  });

  it("serves /wix/velo/backend/:merchantId as a Velo .web.js module with merchant id baked in", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(`${server.url}/wix/velo/backend/${merchant.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("content-disposition")).toContain("zettapay.web.js");
    const body = await res.text();
    expect(body).toContain("import { Permissions, webMethod } from 'wix-web-module'");
    expect(body).toContain("import { fetch } from 'wix-fetch'");
    expect(body).toContain("export const createCheckout");
    expect(body).toContain("export const fetchPaymentStatus");
    expect(body).toContain(`MERCHANT_ID = '${merchant.id}'`);
    expect(body).toContain("https://api.zettapay.test");
    expect(body).not.toContain("__ZETTAPAY_API_BASE__");
    expect(body).not.toContain("__ZETTAPAY_PAY_BASE__");
    expect(body).not.toContain("__ZETTAPAY_BUILD_ID__");
    expect(body).not.toContain("__ZETTAPAY_MERCHANT__");
  });

  it("returns 404 for an unknown merchant Velo module", async () => {
    const res = await fetch(`${server.url}/wix/velo/backend/merch_unknown`);
    expect(res.status).toBe(404);
  });

  it("serves /wix/velo/page as a merchant-agnostic page module", async () => {
    const res = await fetch(`${server.url}/wix/velo/page`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("content-disposition")).toContain("zettapay-checkout.js");
    const body = await res.text();
    expect(body).toContain("from 'backend/zettapay.web.js'");
    expect(body).toContain("$w.onReady");
    expect(body).toContain("#zpPayButton");
    expect(body).not.toContain("__ZETTAPAY_BUILD_ID__");
  });

  it("exposes /wix/app/info onboarding metadata", async () => {
    const res = await fetch(`${server.url}/wix/app/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      version: string;
      submission: { manifest_path: string };
      velo: { backend_module_path: string; page_module_path: string };
      install_steps: string[];
    };
    expect(body.slug).toBe(WIX_APP_SLUG);
    expect(body.submission.manifest_path).toBe("/wix/manifest.json");
    expect(body.velo.backend_module_path).toBe("/wix/velo/backend/<merchantId>");
    expect(body.velo.page_module_path).toBe("/wix/velo/page");
    expect(body.install_steps.length).toBeGreaterThan(0);
  });

  it("backend module sanitizes merchant ids that contain quote characters", () => {
    const evil = renderWixVeloBackendModule({
      apiBase: "https://api.zettapay.test",
      payBase: "https://api.zettapay.test",
      buildId: "0.1.0",
      merchantId: "merch_'<script>",
    });
    expect(evil).not.toContain("<script>");
    expect(evil).not.toContain("'<");
    expect(evil).toContain("MERCHANT_ID = '");
  });

  it("page module references the same backend filename as the manifest declares", () => {
    const manifest = renderWixAppManifest({
      apiBase: "https://api.zettapay.test",
      buildId: "0.1.0",
    });
    const backendComp = manifest.components.find((c) => c.type === "velo_backend_module");
    expect(backendComp?.name).toBe("zettapay.web.js");

    const pageBody = renderWixVeloPageModule({ buildId: "0.1.0" });
    expect(pageBody).toContain("from 'backend/zettapay.web.js'");
  });
});
