import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import bs58 from "bs58";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { insertSubscription } from "../src/db/subscriptions.js";
import { newId } from "../src/lib/id.js";
import {
  buildManageIntentMessage,
  type SubscriptionManageAction,
} from "../src/lib/subscription-manage-auth.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in subscription manage tests");
  },
} as unknown as SolanaService;

function makeCustomerWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { publicKey: bs58.encode(raw), privateKey };
}

function signIntent(
  privateKey: Parameters<typeof cryptoSign>[2],
  args: {
    action: SubscriptionManageAction;
    subscriptionId: string;
    customerWallet: string;
    issuedAt: string;
  },
): string {
  const msg = buildManageIntentMessage(args);
  return bs58.encode(cryptoSign(null, msg, privateKey));
}

describe("/sub/manage HTTP routes", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let merchantId: string;
  const FIXED_NOW = new Date("2026-05-10T12:00:00.000Z").getTime();

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: "owner@acme.test",
      webhookUrl: null,
    });
    merchantId = merchant.id;
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

  function seedSubscription(customerWallet: string) {
    return insertSubscription(db, {
      id: newId("sub"),
      merchantId,
      customerWallet,
      amount: 9.99,
      interval: "monthly",
      nextChargeAt: new Date("2026-06-01T00:00:00.000Z").toISOString(),
    });
  }

  it("GET /sub/manage/:id returns a customer-safe view without API surface", async () => {
    const { publicKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);

    const res = await fetch(`${url}/sub/manage/${sub.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: Record<string, unknown>;
    };
    expect(body.subscription.id).toBe(sub.id);
    expect(body.subscription.customerWallet).toBe(publicKey);
    expect(body.subscription.status).toBe("active");
    expect(body.subscription).not.toHaveProperty("apiKey");
    expect(body.subscription).not.toHaveProperty("authorization");
    expect(body.subscription).not.toHaveProperty("failedChargeCount");
  });

  it("GET /sub/manage/:id returns 404 for unknown id", async () => {
    const res = await fetch(`${url}/sub/manage/sub_does_not_exist`);
    expect(res.status).toBe(404);
  });

  it("GET /sub/manage/:id/intent-message returns canonical bytes for the requested action", async () => {
    const { publicKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);

    const res = await fetch(
      `${url}/sub/manage/${sub.id}/intent-message?action=cancel`,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      schema: string;
      action: string;
      subscriptionId: string;
      customerWallet: string;
      issuedAt: string;
      message: string;
    };
    expect(body.schema).toBe("ZETTAPAY-SUBSCRIPTION-MANAGE-V1");
    expect(body.action).toBe("cancel");
    expect(body.subscriptionId).toBe(sub.id);
    expect(body.customerWallet).toBe(publicKey);
    expect(body.message).toContain(`subscriptionId=${sub.id}`);
    expect(body.message).toContain("action=cancel");
    expect(body.message).toContain(`issuedAt=${body.issuedAt}`);
  });

  it("GET /sub/manage/:id/intent-message rejects unknown action", async () => {
    const { publicKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);
    const res = await fetch(
      `${url}/sub/manage/${sub.id}/intent-message?action=delete`,
    );
    expect(res.status).toBe(400);
  });

  it("POST /sub/manage/:id/cancel transitions status to canceled with valid signature", async () => {
    const { publicKey, privateKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);
    const issuedAt = new Date().toISOString();
    const signature = signIntent(privateKey, {
      action: "cancel",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt,
    });

    const res = await fetch(`${url}/sub/manage/${sub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature, issuedAt }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      subscription: { status: string };
    };
    expect(body.subscription.status).toBe("canceled");
  });

  it("POST /sub/manage/:id/pause transitions active → paused, then resume → active", async () => {
    const { publicKey, privateKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);

    const pauseAt = new Date().toISOString();
    const pauseSig = signIntent(privateKey, {
      action: "pause",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt: pauseAt,
    });
    const pauseRes = await fetch(`${url}/sub/manage/${sub.id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature: pauseSig, issuedAt: pauseAt }),
    });
    expect(pauseRes.status).toBe(200);
    expect(((await pauseRes.json()) as { subscription: { status: string } }).subscription.status).toBe(
      "paused",
    );

    const resumeAt = new Date().toISOString();
    const resumeSig = signIntent(privateKey, {
      action: "resume",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt: resumeAt,
    });
    const resumeRes = await fetch(`${url}/sub/manage/${sub.id}/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature: resumeSig, issuedAt: resumeAt }),
    });
    expect(resumeRes.status).toBe(200);
    expect(
      ((await resumeRes.json()) as { subscription: { status: string } }).subscription.status,
    ).toBe("active");
  });

  it("POST /sub/manage/:id/cancel rejects a signature minted by a different wallet (403)", async () => {
    const owner = makeCustomerWallet();
    const intruder = makeCustomerWallet();
    const sub = seedSubscription(owner.publicKey);
    const issuedAt = new Date().toISOString();
    const signature = signIntent(intruder.privateKey, {
      action: "cancel",
      subscriptionId: sub.id,
      customerWallet: intruder.publicKey,
      issuedAt,
    });

    const res = await fetch(`${url}/sub/manage/${sub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: intruder.publicKey,
        signature,
        issuedAt,
      }),
    });
    expect(res.status).toBe(403);
  });

  it("POST /sub/manage/:id/cancel rejects a stale issuedAt outside the replay window", async () => {
    const { publicKey, privateKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);
    const stale = new Date(FIXED_NOW - 60 * 60 * 1000).toISOString();
    const signature = signIntent(privateKey, {
      action: "cancel",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt: stale,
    });

    const res = await fetch(`${url}/sub/manage/${sub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature, issuedAt: stale }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { code: string } } };
    expect(body.error.details?.code).toBe("issued_at_expired");
  });

  it("POST /sub/manage/:id/pause is rejected when subscription is already canceled (409)", async () => {
    const { publicKey, privateKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);

    // First cancel the subscription
    const cancelAt = new Date().toISOString();
    const cancelSig = signIntent(privateKey, {
      action: "cancel",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt: cancelAt,
    });
    await fetch(`${url}/sub/manage/${sub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature: cancelSig, issuedAt: cancelAt }),
    });

    const pauseAt = new Date().toISOString();
    const pauseSig = signIntent(privateKey, {
      action: "pause",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt: pauseAt,
    });
    const res = await fetch(`${url}/sub/manage/${sub.id}/pause`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature: pauseSig, issuedAt: pauseAt }),
    });
    expect(res.status).toBe(409);
  });

  it("POST /sub/manage/:id/cancel rejects a signature minted for a different action", async () => {
    const { publicKey, privateKey } = makeCustomerWallet();
    const sub = seedSubscription(publicKey);
    const issuedAt = new Date().toISOString();
    // Customer signed a "pause" intent, attacker tries to use it on the cancel route.
    const signature = signIntent(privateKey, {
      action: "pause",
      subscriptionId: sub.id,
      customerWallet: publicKey,
      issuedAt,
    });

    const res = await fetch(`${url}/sub/manage/${sub.id}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ publicKey, signature, issuedAt }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { details?: { code: string } } };
    expect(body.error.details?.code).toBe("invalid_signature");
  });
});
