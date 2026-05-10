import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in webflow tests");
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
    email: `webflow-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: null,
  });
}

describe("Webflow embed script", () => {
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

  it("serves /webflow/embed.js as JavaScript with cache headers", async () => {
    const res = await fetch(`${server.url}/webflow/embed.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/javascript");
    expect(res.headers.get("cache-control")).toContain("max-age=");
    expect(res.headers.get("x-zettapay-build")).toBeTruthy();
    const body = await res.text();
    expect(body.length).toBeGreaterThan(500);
    expect(body).toContain("data-zettapay-merchant");
    expect(body).toContain("/pay/checkout");
    expect(body).toContain("https://api.zettapay.test");
    expect(body).not.toContain("__ZETTAPAY_PAY_BASE__");
    expect(body).not.toContain("__ZETTAPAY_BUILD_ID__");
  });

  it("renders /webflow/snippet/:merchantId with merchant id and script tag", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(`${server.url}/webflow/snippet/${merchant.id}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain(`data-zettapay-merchant="${merchant.id}"`);
    expect(body).toContain("https://api.zettapay.test/webflow/embed.js");
    expect(body).toContain("<script");
  });

  it("returns 404 for an unknown merchant snippet", async () => {
    const res = await fetch(`${server.url}/webflow/snippet/merch_unknown`);
    expect(res.status).toBe(404);
  });

  it("escapes HTML-significant characters in merchant names", async () => {
    const merchant = makeMerchant(db, { name: 'Acme "Pro" <Crew>' });
    const res = await fetch(`${server.url}/webflow/snippet/${merchant.id}`);
    const body = await res.text();
    expect(body).not.toContain('"Pro"');
    expect(body).toContain("&quot;Pro&quot;");
    expect(body).toContain("&lt;Crew&gt;");
  });

  it("evaluates the embed script without runtime errors and exposes window.ZettaPay", async () => {
    const res = await fetch(`${server.url}/webflow/embed.js`);
    const body = await res.text();
    const fakeListeners: Record<string, Array<(ev: unknown) => void>> = {};
    const fakeWindow: Record<string, unknown> = {};
    const fakeDocument = {
      readyState: "complete",
      head: { appendChild: () => undefined },
      body: { appendChild: () => undefined },
      addEventListener: (name: string, fn: (ev: unknown) => void) => {
        (fakeListeners[name] ||= []).push(fn);
      },
      removeEventListener: () => undefined,
      querySelectorAll: () => [],
      getElementById: () => null,
      createElement: () => ({
        appendChild: () => undefined,
        addEventListener: () => undefined,
        setAttribute: () => undefined,
        classList: { add: () => undefined },
      }),
    };
    const fn = new Function("window", "document", "MutationObserver", body);
    fn(fakeWindow, fakeDocument, undefined);
    const zp = fakeWindow.ZettaPay as {
      __loaded: boolean;
      payBase: string;
      mount: unknown;
      open: unknown;
      close: unknown;
    };
    expect(zp).toBeTruthy();
    expect(zp.__loaded).toBe(true);
    expect(zp.payBase).toBe("https://api.zettapay.test");
    expect(typeof zp.mount).toBe("function");
    expect(typeof zp.open).toBe("function");
    expect(typeof zp.close).toBe("function");
  });

  it("exposes /webflow/plugin/info metadata for dashboard onboarding", async () => {
    const res = await fetch(`${server.url}/webflow/plugin/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      version: string;
      embed: { attribute: string; script_path: string; snippet_path: string };
      install_steps: string[];
    };
    expect(body.slug).toBe("zettapay-webflow-embed");
    expect(body.embed.attribute).toBe("data-zettapay-merchant");
    expect(body.embed.script_path).toBe("/webflow/embed.js");
    expect(body.install_steps.length).toBeGreaterThan(0);
  });
});
