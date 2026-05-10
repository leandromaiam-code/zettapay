import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { findInstallationByShopDomain } from "../src/db/shopify.js";
import { registerMerchant } from "../src/services/merchants.js";
import type { SolanaService } from "../src/services/solana.js";
import type { ShopifyTokenExchanger } from "../src/services/shopify.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in shopify tests");
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

function signOAuth(params: Record<string, string>, secret: string): string {
  const msg = Object.entries(params)
    .filter(([k]) => k !== "hmac" && k !== "signature")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return createHmac("sha256", secret).update(msg).digest("hex");
}

function makeMerchant(db: Db) {
  return registerMerchant(db, {
    name: "Acme Coffee",
    walletAddress: Keypair.generate().publicKey.toBase58(),
    email: `acme-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: null,
  });
}

describe("Shopify OAuth flow", () => {
  let db: Db;
  let server: Server;

  const fakeExchanger: ShopifyTokenExchanger = async () => ({
    access_token: "shpat_fake_access_token",
    scope: "read_orders,write_script_tags",
  });

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: dummySolana,
      shopify: SHOPIFY_CONFIG,
      shopifyTokenExchanger: fakeExchanger,
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("redirects /shopify/install to Shopify authorize URL with state", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(
      `${server.url}/shopify/install?shop=acme.myshopify.com&merchant_id=${merchant.id}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    expect(location).toBeTruthy();
    const url = new URL(location!);
    expect(url.host).toBe("acme.myshopify.com");
    expect(url.pathname).toBe("/admin/oauth/authorize");
    expect(url.searchParams.get("client_id")).toBe(SHOPIFY_CONFIG.apiKey);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://api.zettapay.test/shopify/callback",
    );
    expect(url.searchParams.get("scope")).toBe(SHOPIFY_CONFIG.scopes);
    const state = url.searchParams.get("state");
    expect(state).toMatch(/^[a-f0-9]{48}$/);

    const installation = findInstallationByShopDomain(db, "acme.myshopify.com");
    expect(installation?.merchantId).toBe(merchant.id);
    expect(installation?.status).toBe("pending");
    expect(installation?.oauthNonce).toBe(state);
  });

  it("rejects /shopify/install with a non-Shopify domain", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(
      `${server.url}/shopify/install?shop=attacker.com&merchant_id=${merchant.id}`,
      { redirect: "manual" },
    );
    expect(res.status).toBe(400);
  });

  it("completes OAuth via /shopify/callback with valid HMAC + state", async () => {
    const merchant = makeMerchant(db);
    const installRes = await fetch(
      `${server.url}/shopify/install?shop=acme.myshopify.com&merchant_id=${merchant.id}`,
      { redirect: "manual" },
    );
    const installLocation = new URL(installRes.headers.get("location")!);
    const state = installLocation.searchParams.get("state")!;

    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "shopify_temp_code",
      state,
      timestamp: "1700000000",
    };
    const hmac = signOAuth(params, SHOPIFY_CONFIG.apiSecret);
    const qs = new URLSearchParams({ ...params, hmac });
    const res = await fetch(`${server.url}/shopify/callback?${qs.toString()}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; installation: { status: string; merchantId: string } };
    expect(body.ok).toBe(true);
    expect(body.installation.status).toBe("installed");
    expect(body.installation.merchantId).toBe(merchant.id);

    const installation = findInstallationByShopDomain(db, "acme.myshopify.com");
    expect(installation?.status).toBe("installed");
    expect(installation?.accessToken).toBe("shpat_fake_access_token");
    expect(installation?.oauthNonce).toBeNull();
  });

  it("rejects /shopify/callback with a forged HMAC", async () => {
    const merchant = makeMerchant(db);
    await fetch(
      `${server.url}/shopify/install?shop=acme.myshopify.com&merchant_id=${merchant.id}`,
      { redirect: "manual" },
    );

    const qs = new URLSearchParams({
      shop: "acme.myshopify.com",
      code: "x",
      state: "doesnt-matter",
      hmac: "deadbeef".repeat(8),
    });
    const res = await fetch(`${server.url}/shopify/callback?${qs.toString()}`);
    expect(res.status).toBe(401);
  });

  it("rejects /shopify/callback with a stale OAuth state", async () => {
    const merchant = makeMerchant(db);
    await fetch(
      `${server.url}/shopify/install?shop=acme.myshopify.com&merchant_id=${merchant.id}`,
      { redirect: "manual" },
    );

    const params: Record<string, string> = {
      shop: "acme.myshopify.com",
      code: "x",
      state: "stale-nonce-from-attacker",
      timestamp: "1700000000",
    };
    const hmac = signOAuth(params, SHOPIFY_CONFIG.apiSecret);
    const qs = new URLSearchParams({ ...params, hmac });
    const res = await fetch(`${server.url}/shopify/callback?${qs.toString()}`);
    expect(res.status).toBe(401);
  });

  it("returns 503 when Shopify credentials are not configured", async () => {
    closeDatabase();
    const db2 = openDatabase(":memory:");
    const merchant = makeMerchant(db2);
    const app = createApp({ db: db2, solana: dummySolana });
    const s = await startApp(app);
    try {
      const res = await fetch(
        `${s.url}/shopify/install?shop=acme.myshopify.com&merchant_id=${merchant.id}`,
        { redirect: "manual" },
      );
      expect(res.status).toBe(503);
    } finally {
      await s.close();
    }
  });
});

describe("Shopify Liquid snippet", () => {
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

  it("renders a Liquid snippet with the merchant id and pay URL", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(`${server.url}/shopify/snippet/${merchant.id}.liquid`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/liquid");
    const body = await res.text();
    expect(body).toContain(`data-merchant-id="${merchant.id}"`);
    expect(body).toContain("https://api.zettapay.test/pay/checkout");
    expect(body).toContain("{{ cart.total_price");
    expect(body).toContain("ZettaPay");
  });

  it("returns 404 for an unknown merchant", async () => {
    const res = await fetch(`${server.url}/shopify/snippet/merch_unknown.liquid`);
    expect(res.status).toBe(404);
  });

  it("escapes merchant names that contain HTML-significant characters", async () => {
    const merchant = registerMerchant(db, {
      name: 'Acme "Pro" <Crew>',
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "evil@test.com",
      webhookUrl: null,
    });
    const res = await fetch(`${server.url}/shopify/snippet/${merchant.id}.liquid`);
    const body = await res.text();
    expect(body).not.toContain('"Pro"');
    expect(body).toContain("&quot;Pro&quot;");
    expect(body).toContain("&lt;Crew&gt;");
  });
});
