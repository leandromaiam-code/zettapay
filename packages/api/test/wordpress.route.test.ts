import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { renderWordPressShortcode } from "../src/lib/wordpress.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in wordpress tests");
  },
} as unknown as SolanaService;

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
    email: `wp-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: null,
  });
}

describe("WordPress plugin info routes", () => {
  let db: Db;
  let server: Server;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("exposes the public plugin metadata + shortcode contract", async () => {
    const res = await fetch(`${server.url}/wordpress/plugin/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      version: string;
      requires_wordpress: string;
      requires_php: string;
      shortcode: {
        tag: string;
        attribute: string;
        example: string;
        supported_attributes: string[];
      };
      install_steps: string[];
    };
    expect(body.slug).toBe("zettapay-wordpress");
    expect(body.shortcode.tag).toBe("zettapay");
    expect(body.shortcode.attribute).toBe("merchant");
    expect(body.shortcode.example).toContain("[zettapay");
    expect(body.shortcode.supported_attributes).toContain("merchant");
    expect(body.shortcode.supported_attributes).toContain("amount");
    expect(body.shortcode.supported_attributes).toContain("modal");
    expect(body.install_steps.length).toBeGreaterThan(0);
  });

  it("returns merchant-scoped onboarding metadata with a copy-pasteable shortcode", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(`${server.url}/wordpress/plugin/info/${merchant.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { id: string; name: string };
      shortcode: { tag: string; snippet: string };
    };
    expect(body.merchant.id).toBe(merchant.id);
    expect(body.merchant.name).toBe("Acme Coffee");
    expect(body.shortcode.tag).toBe("zettapay");
    expect(body.shortcode.snippet).toContain(`merchant="${merchant.id}"`);
    expect(body.shortcode.snippet).toContain('amount="10.00"');
  });

  it("returns 404 for an unknown merchant", async () => {
    const res = await fetch(`${server.url}/wordpress/plugin/info/merch_unknown`);
    expect(res.status).toBe(404);
  });

  it("strips characters that would break out of a shortcode attribute", () => {
    const snippet = renderWordPressShortcode({
      merchantId: 'merch_x"><script>alert(1)</script>',
      merchantName: 'Acme "Pro" <Crew>',
      sampleAmount: "12.50",
    });
    expect(snippet).not.toContain("<script>");
    expect(snippet).not.toContain('"Pro"');
    expect(snippet).not.toContain("<Crew>");
    // Both the merchant id and name flow through the same sanitizer, so the
    // output must not contain unescaped quotes anywhere except the attribute
    // wrappers we generate ourselves.
    const quoteCount = (snippet.match(/"/g) || []).length;
    expect(quoteCount).toBe(6); // 3 attrs × 2 quotes each (merchant, amount, currency).
  });

  it("omits the amount attribute when no sampleAmount is provided", () => {
    const snippet = renderWordPressShortcode({
      merchantId: "merch_abc",
      merchantName: "Acme",
    });
    expect(snippet).toContain('merchant="merch_abc"');
    expect(snippet).not.toContain("amount=");
  });
});
