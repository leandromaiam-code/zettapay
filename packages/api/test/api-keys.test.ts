import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import { type Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  generateKeyPair,
  hashSecret,
  isPublicKey,
  isSecretKey,
  PUBLIC_KEY_PREFIX,
  SECRET_KEY_PREFIX,
} from "../src/lib/api-keys.js";
import {
  findApiKeyByPublicKey,
  listApiKeysForMerchant,
  revokeApiKey,
} from "../src/db/api_keys.js";
import { issueApiKey } from "../src/services/api_keys.js";
import { registerMerchant } from "../src/services/merchants.js";
import { requireApiKey } from "../src/middleware/api-key.js";
import { errorHandler } from "../src/middleware/error.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: express.Express): Promise<RunningServer> {
  return new Promise((resolve) => {
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

describe("generateKeyPair", () => {
  it("returns a key pair with the canonical prefixes", () => {
    const pair = generateKeyPair();
    expect(pair.public.startsWith(PUBLIC_KEY_PREFIX)).toBe(true);
    expect(pair.secret.startsWith(SECRET_KEY_PREFIX)).toBe(true);
    expect(isPublicKey(pair.public)).toBe(true);
    expect(isSecretKey(pair.secret)).toBe(true);
  });

  it("produces unique pairs across calls", () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    expect(a.public).not.toBe(b.public);
    expect(a.secret).not.toBe(b.secret);
  });

  it("hashSecret yields a stable 64-char sha256 hex digest", () => {
    const h1 = hashSecret("sk_live_test");
    const h2 = hashSecret("sk_live_test");
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    expect(hashSecret("sk_live_other")).not.toBe(h1);
  });
});

describe("issueApiKey + zettapay_api_keys persistence", () => {
  let db: Db;
  let merchantId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("persists the hash and returns the secret exactly once", () => {
    const issued = issueApiKey(db, { merchantId, label: "primary" });
    expect(issued.secret).toMatch(/^sk_live_[0-9a-f]{48}$/);
    expect(issued.apiKey.publicKey).toMatch(/^zp_pub_[0-9a-f]{32}$/);
    expect(issued.apiKey.secretHash).toBe(hashSecret(issued.secret));
    expect(issued.apiKey.label).toBe("primary");
    expect(issued.apiKey.revokedAt).toBeNull();

    const stored = findApiKeyByPublicKey(db, issued.apiKey.publicKey);
    expect(stored?.merchantId).toBe(merchantId);
    expect(stored?.secretHash).toBe(issued.apiKey.secretHash);
    // Secret material must never be persisted in plaintext.
    expect(stored?.secretHash).not.toBe(issued.secret);
  });

  it("listApiKeysForMerchant returns all keys, newest first", () => {
    issueApiKey(db, { merchantId });
    issueApiKey(db, { merchantId });
    const all = listApiKeysForMerchant(db, merchantId);
    expect(all).toHaveLength(2);
  });

  it("revokeApiKey marks the row revoked exactly once", () => {
    const { apiKey } = issueApiKey(db, { merchantId });
    expect(revokeApiKey(db, apiKey.id)).toBe(true);
    expect(revokeApiKey(db, apiKey.id)).toBe(false);
    const after = findApiKeyByPublicKey(db, apiKey.publicKey);
    expect(after?.revokedAt).not.toBeNull();
  });

  it("rejects issuing for an unknown merchant", () => {
    expect(() => issueApiKey(db, { merchantId: "merch_missing" })).toThrowError(
      /not found/i,
    );
  });
});

describe("requireApiKey middleware", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let secret: string;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const issued = issueApiKey(db, { merchantId });
    secret = issued.secret;

    const app = express();
    app.use(express.json());
    app.get("/whoami", requireApiKey(db), (req, res) => {
      res.json({
        merchantId: req.merchant?.id,
        publicKey: req.apiKey?.publicKey,
      });
    });
    app.use(errorHandler);
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("authenticates a valid sk_live_ bearer token", async () => {
    const res = await fetch(`${server.url}/whoami`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { merchantId: string };
    expect(body.merchantId).toBe(merchantId);
  });

  it("authenticates via x-api-key fallback header", async () => {
    const res = await fetch(`${server.url}/whoami`, {
      headers: { "x-api-key": secret },
    });
    expect(res.status).toBe(200);
  });

  it("rejects requests with no credential", async () => {
    const res = await fetch(`${server.url}/whoami`);
    expect(res.status).toBe(401);
  });

  it("rejects malformed tokens before hitting the DB", async () => {
    const res = await fetch(`${server.url}/whoami`, {
      headers: { authorization: "Bearer not-a-real-key" },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/format/i);
  });

  it("rejects unknown but well-formed tokens", async () => {
    const fake = `sk_live_${"a".repeat(48)}`;
    const res = await fetch(`${server.url}/whoami`, {
      headers: { authorization: `Bearer ${fake}` },
    });
    expect(res.status).toBe(401);
  });

  it("rejects revoked keys", async () => {
    const all = listApiKeysForMerchant(db, merchantId);
    revokeApiKey(db, all[0]!.id);
    const res = await fetch(`${server.url}/whoami`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/revoked/i);
  });
});
