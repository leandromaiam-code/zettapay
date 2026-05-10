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
    throw new Error("not used in woocommerce tests");
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

function makeMerchant(db: Db) {
  return registerMerchant(db, {
    name: "WooStore Sample",
    walletAddress: Keypair.generate().publicKey.toBase58(),
    email: `woo-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: "https://merchant.example.com/wp-json/zettapay/v1/webhook",
  });
}

describe("WooCommerce plugin info routes", () => {
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

  it("exposes the public plugin signature contract", async () => {
    const res = await fetch(`${server.url}/woocommerce/plugin/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slug: string;
      version: string;
      signature: {
        algorithm: string;
        signature_header: string;
        timestamp_header: string;
        signed_payload: string;
        tolerance_sec: number;
      };
      install_steps: string[];
    };
    expect(body.slug).toBe("zettapay-for-woocommerce");
    expect(body.signature.algorithm).toBe("hmac-sha256");
    expect(body.signature.signature_header).toBe("X-ZettaPay-Signature");
    expect(body.signature.timestamp_header).toBe("X-ZettaPay-Timestamp");
    expect(body.signature.signed_payload).toBe("<timestamp>.<raw_body>");
    expect(body.signature.tolerance_sec).toBe(300);
    expect(body.install_steps.length).toBeGreaterThan(0);
  });

  it("returns merchant-scoped onboarding metadata", async () => {
    const merchant = makeMerchant(db);
    const res = await fetch(`${server.url}/woocommerce/plugin/info/${merchant.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchant: { id: string; name: string };
      webhook: { configured_url: string | null; signing_secret_present: boolean };
    };
    expect(body.merchant.id).toBe(merchant.id);
    expect(body.merchant.name).toBe("WooStore Sample");
    expect(body.webhook.configured_url).toBe(
      "https://merchant.example.com/wp-json/zettapay/v1/webhook",
    );
    expect(body.webhook.signing_secret_present).toBe(true);
  });

  it("returns 404 for an unknown merchant", async () => {
    const res = await fetch(`${server.url}/woocommerce/plugin/info/merch_unknown`);
    expect(res.status).toBe(404);
  });
});
