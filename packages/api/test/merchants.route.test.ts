import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in merchant tests");
  },
} as unknown as SolanaService;

describe("POST /merchants/register", () => {
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

  it("registers a merchant and issues an api key", async () => {
    const res = await fetch(`${url}/merchants/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme",
        walletAddress: Keypair.generate().publicKey.toBase58(),
        email: "owner@acme.test",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { merchant: { id: string; apiKey: string } };
    expect(body.merchant.id).toMatch(/^merch_/);
    expect(body.merchant.apiKey).toMatch(/^zp_live_/);
  });

  it("rejects an invalid solana address", async () => {
    const res = await fetch(`${url}/merchants/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Acme",
        walletAddress: "not-a-valid-pubkey",
        email: "x@y.test",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects duplicate email with 409", async () => {
    const wallet1 = Keypair.generate().publicKey.toBase58();
    const wallet2 = Keypair.generate().publicKey.toBase58();
    const first = await fetch(`${url}/merchants/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A", walletAddress: wallet1, email: "dup@x.test" }),
    });
    expect(first.status).toBe(201);
    const second = await fetch(`${url}/merchants/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "B", walletAddress: wallet2, email: "dup@x.test" }),
    });
    expect(second.status).toBe(409);
  });
});
