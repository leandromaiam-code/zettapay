import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import type { Database as Db } from "better-sqlite3";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import {
  insertSubscription,
  setSubscriptionAuthorization,
  findSubscription,
} from "../src/db/subscriptions.js";
import { newId } from "../src/lib/id.js";
import { buildAuthorizationMessage } from "../src/lib/subscription-auth.js";
import {
  chargeDueSubscriptions,
} from "../src/services/subscription_charger.js";
import { startSubscriptionCron } from "../src/services/subscription_cron.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { getPayment } from "../src/db/payments.js";
import type { SolanaService } from "../src/services/solana.js";

function makeSolanaWallet() {
  // Generate an ed25519 keypair via Node crypto so the raw 32-byte spki tail
  // can stand in as a Solana base58 wallet address while still letting us
  // sign canonical messages with the matching private key.
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const raw = spki.subarray(spki.length - 32);
  return { walletAddress: bs58.encode(raw), privateKey };
}

interface StubSolana {
  transferToken: ReturnType<typeof vi.fn>;
  getPayerPublicKey: ReturnType<typeof vi.fn>;
}

function makeStubSolana(opts: {
  shouldFail?: boolean;
  signature?: string;
} = {}): StubSolana {
  return {
    transferToken: vi.fn(async (params: { recipientOwner: PublicKey; amount: number }) => {
      if (opts.shouldFail) throw new Error("rpc_unreachable");
      return {
        signature: opts.signature ?? `sig_${Math.random().toString(36).slice(2, 10)}`,
        payerWallet: Keypair.generate().publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
        currency: "USDC",
        mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      };
    }),
    getPayerPublicKey: vi.fn(() => Keypair.generate().publicKey),
  };
}

function seedAuthorizedSubscription(
  db: Db,
  opts: {
    merchantId: string;
    nextChargeAt: string;
    amount?: number;
  },
) {
  const wallet = makeSolanaWallet();
  const sub = insertSubscription(db, {
    id: newId("sub"),
    merchantId: opts.merchantId,
    customerWallet: wallet.walletAddress,
    amount: opts.amount ?? 5,
    interval: "daily",
    nextChargeAt: opts.nextChargeAt,
    currency: "USDC",
  });
  const message = buildAuthorizationMessage({
    subscriptionId: sub.id,
    merchantId: sub.merchantId,
    customerWallet: sub.customerWallet,
    amount: sub.amount,
    currency: sub.currency,
    interval: sub.interval,
  });
  const signature = bs58.encode(cryptoSign(null, message, wallet.privateKey));
  setSubscriptionAuthorization(db, sub.id, {
    signature,
    publicKey: wallet.walletAddress,
  });
  return findSubscription(db, sub.id)!;
}

describe("chargeDueSubscriptions", () => {
  let db: Db;
  let merchantId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `m+${Math.random().toString(36).slice(2)}@test.io`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("charges a due subscription when the authorization signature is valid", async () => {
    const sub = seedAuthorizedSubscription(db, {
      merchantId,
      nextChargeAt: "2026-01-01T00:00:00.000Z",
      amount: 7.5,
    });
    const solana = makeStubSolana({ signature: "sig_happy_path" });

    const outcomes = await chargeDueSubscriptions(
      db,
      solana as unknown as SolanaService,
      { now: new Date("2026-05-10T00:00:00.000Z") },
    );

    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.status).toBe("charged");
    expect(solana.transferToken).toHaveBeenCalledTimes(1);
    expect(solana.transferToken.mock.calls[0]?.[0]?.amount).toBe(7.5);

    const refreshed = findSubscription(db, sub.id)!;
    expect(refreshed.lastChargeAt).toBe("2026-05-10T00:00:00.000Z");
    expect(refreshed.failedChargeCount).toBe(0);
    // daily interval advances by 1 day from the original next_charge_at
    expect(refreshed.nextChargeAt).toBe("2026-01-02T00:00:00.000Z");

    if (outcome.status === "charged") {
      const payment = getPayment(db, outcome.paymentId);
      expect(payment.status).toBe("completed");
      expect(payment.txSignature).toBe("sig_happy_path");
      expect(payment.amountUsdc).toBe(7.5);
      expect(payment.metadata).toMatchObject({
        source: "subscription",
        subscriptionId: sub.id,
      });
    }

    const audit = listAuditEntries(db, {
      entityType: "subscription",
      entityId: sub.id,
    });
    expect(audit.find((e) => e.event === "subscription.charged")).toBeTruthy();
  });

  it("skips subscriptions with no authorization and increments failure count", async () => {
    const wallet = makeSolanaWallet();
    const sub = insertSubscription(db, {
      id: newId("sub"),
      merchantId,
      customerWallet: wallet.walletAddress,
      amount: 1,
      interval: "daily",
      nextChargeAt: "2026-01-01T00:00:00.000Z",
    });
    const solana = makeStubSolana();
    const outcomes = await chargeDueSubscriptions(
      db,
      solana as unknown as SolanaService,
      { now: new Date("2026-05-10T00:00:00.000Z") },
    );
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.status).toBe("failed");
    expect(solana.transferToken).not.toHaveBeenCalled();

    const refreshed = findSubscription(db, sub.id)!;
    expect(refreshed.failedChargeCount).toBe(1);
    expect(refreshed.lastFailureReason).toBe("missing_authorization");
  });

  it("auto-pauses the subscription after three consecutive failures", async () => {
    const sub = seedAuthorizedSubscription(db, {
      merchantId,
      nextChargeAt: "2026-01-01T00:00:00.000Z",
    });
    const solana = makeStubSolana({ shouldFail: true });

    for (let i = 0; i < 3; i++) {
      await chargeDueSubscriptions(db, solana as unknown as SolanaService, {
        now: new Date("2026-05-10T00:00:00.000Z"),
      });
    }
    const refreshed = findSubscription(db, sub.id)!;
    expect(refreshed.status).toBe("paused");
    expect(refreshed.failedChargeCount).toBe(3);
  });

  it("rejects a tampered binding even if the row was UPDATEd post-sign", async () => {
    const sub = seedAuthorizedSubscription(db, {
      merchantId,
      nextChargeAt: "2026-01-01T00:00:00.000Z",
      amount: 5,
    });
    // Tamper with the amount AFTER the customer signed.
    db.prepare("UPDATE subscriptions SET amount = ? WHERE id = ?").run(500, sub.id);

    const solana = makeStubSolana();
    const outcomes = await chargeDueSubscriptions(
      db,
      solana as unknown as SolanaService,
      { now: new Date("2026-05-10T00:00:00.000Z") },
    );
    expect(outcomes[0]?.status).toBe("failed");
    expect(solana.transferToken).not.toHaveBeenCalled();
    if (outcomes[0]?.status === "failed") {
      expect(outcomes[0].reason).toContain("auth:invalid_signature");
    }
  });

  it("does not pick up subscriptions whose next_charge_at is in the future", async () => {
    seedAuthorizedSubscription(db, {
      merchantId,
      nextChargeAt: "2099-01-01T00:00:00.000Z",
    });
    const solana = makeStubSolana();
    const outcomes = await chargeDueSubscriptions(
      db,
      solana as unknown as SolanaService,
      { now: new Date("2026-05-10T00:00:00.000Z") },
    );
    expect(outcomes).toHaveLength(0);
    expect(solana.transferToken).not.toHaveBeenCalled();
  });
});

describe("startSubscriptionCron", () => {
  let db: Db;
  let merchantId: string;

  beforeEach(() => {
    closeDatabase();
    db = openDatabase(":memory:");
    const merchant = registerMerchant(db, {
      name: "Acme",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `cron+${Math.random().toString(36).slice(2)}@test.io`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
  });

  it("processes due subscriptions on each tick() and stops cleanly on close()", async () => {
    const sub = seedAuthorizedSubscription(db, {
      merchantId,
      nextChargeAt: "2026-01-01T00:00:00.000Z",
    });
    const solana = makeStubSolana();
    const handle = startSubscriptionCron({
      db,
      solana: solana as unknown as SolanaService,
      intervalMs: 60_000,
    });
    try {
      await handle.tick();
      expect(solana.transferToken).toHaveBeenCalledTimes(1);
      const refreshed = findSubscription(db, sub.id)!;
      expect(refreshed.lastChargeAt).not.toBeNull();
    } finally {
      await handle.close();
    }
  });
});
