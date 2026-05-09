import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { signWebhookPayload } from "../src/lib/webhook-signature.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in verify-signature tests");
  },
} as unknown as SolanaService;

interface RegisterResponse {
  merchant: {
    id: string;
    apiKey: string;
    webhookUrl: string | null;
    webhookSecret: string | null;
  };
}

async function register(
  url: string,
  webhookUrl: string | null,
): Promise<RegisterResponse["merchant"]> {
  const res = await fetch(`${url}/merchants/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `owner-${Math.random().toString(36).slice(2)}@acme.test`,
      webhookUrl,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as RegisterResponse;
  return body.merchant;
}

describe("POST /verify-signature", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    await new Promise<void>((resolve) => {
      const server = app.listen(0, () => {
        const { port } = server.address() as AddressInfo;
        url = `http://127.0.0.1:${port}`;
        close = () =>
          new Promise<void>((r) => {
            server.close(() => r());
          });
        resolve();
      });
    });
  });

  afterEach(async () => {
    await close();
    closeDatabase();
  });

  it("issues a webhook secret only when webhookUrl is configured", async () => {
    const withHook = await register(url, "https://hooks.acme.test/zp");
    const withoutHook = await register(url, null);
    expect(withHook.webhookSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(withoutHook.webhookSecret).toBeNull();
  });

  it("returns valid:true for a correctly signed payload", async () => {
    const merchant = await register(url, "https://hooks.acme.test/zp");
    const payload = JSON.stringify({ event: "payment.completed", id: "pay_1" });
    const ts = String(Date.now());
    const signature = signWebhookPayload({
      secret: merchant.webhookSecret as string,
      payload,
      timestamp: ts,
    });

    const res = await fetch(`${url}/verify-signature`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({ payload, signature, timestamp: ts }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean };
    expect(body.valid).toBe(true);
  });

  it("returns valid:false with reason for a tampered payload", async () => {
    const merchant = await register(url, "https://hooks.acme.test/zp");
    const payload = JSON.stringify({ event: "payment.completed", id: "pay_1" });
    const ts = String(Date.now());
    const signature = signWebhookPayload({
      secret: merchant.webhookSecret as string,
      payload,
      timestamp: ts,
    });

    const res = await fetch(`${url}/verify-signature`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({ payload: payload + "x", signature, timestamp: ts }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { valid: boolean; reason: string };
    expect(body.valid).toBe(false);
    expect(body.reason).toBe("signature_mismatch");
  });

  it("rejects requests without an API key", async () => {
    const res = await fetch(`${url}/verify-signature`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "{}", signature: "sha256=abc", timestamp: "0" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects requests with an unknown API key", async () => {
    const res = await fetch(`${url}/verify-signature`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": "zp_live_unknown",
      },
      body: JSON.stringify({ payload: "{}", signature: "sha256=abc", timestamp: "0" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects merchants without a configured webhook secret", async () => {
    const merchant = await register(url, null);
    const res = await fetch(`${url}/verify-signature`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({ payload: "{}", signature: "sha256=abc", timestamp: "0" }),
    });
    expect(res.status).toBe(400);
  });

  it("exposes signing format via GET /verify-signature/info", async () => {
    const res = await fetch(`${url}/verify-signature/info`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      algorithm: string;
      signatureFormat: string;
      headers: { signature: string; timestamp: string };
    };
    expect(body.algorithm).toBe("HMAC-SHA256");
    expect(body.headers.signature).toBe("X-ZettaPay-Signature");
  });
});
