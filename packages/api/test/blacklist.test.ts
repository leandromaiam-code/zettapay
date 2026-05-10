import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { openDatabase, closeDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { findMerchantById } from "../src/db/merchants.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import {
  enforceBlacklist,
  isBlacklisted,
  listBlacklistEntries,
  lookupBlacklist,
  resetBlacklistCache,
} from "../src/services/blacklist.js";
import { OFAC_SANCTIONED_ADDRESSES } from "../src/services/blacklist-data.js";
import type { SolanaService } from "../src/services/solana.js";
import { HttpError } from "../src/lib/errors.js";

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

function makeFakeSolana(payerKp: Keypair): SolanaService {
  return {
    getPayerPublicKey: () => payerKp.publicKey,
    getCluster: () => "devnet" as const,
    getMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferToken: vi.fn(
      async (params: { recipientOwner: PublicKey; amount: number }) => ({
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
        currency: "USDC",
        mintAddress: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      }),
    ),
  } as unknown as SolanaService;
}

describe("blacklist service", () => {
  beforeEach(() => {
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
  });

  afterEach(() => {
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
  });

  it("ships the public Tornado Cash OFAC SDN addresses in the seed list", () => {
    const seeded = listBlacklistEntries().map((e) => e.address);
    // Sanity check: seed list is non-empty and includes the well-known
    // Tornado Cash router address from the Aug 8 2022 designation.
    expect(seeded.length).toBeGreaterThanOrEqual(7);
    expect(seeded).toContain("0x722122dF12D4e14e13Ac3b6895a86e84145b6967");
  });

  it("isBlacklisted matches addresses on the seed list", () => {
    const sample = OFAC_SANCTIONED_ADDRESSES[0];
    expect(sample).toBeDefined();
    expect(isBlacklisted(sample!.address)).toBe(true);
  });

  it("isBlacklisted returns false for clean wallets", () => {
    const fresh = Keypair.generate().publicKey.toBase58();
    expect(isBlacklisted(fresh)).toBe(false);
  });

  it("returns false for null/empty/whitespace input", () => {
    expect(isBlacklisted(null)).toBe(false);
    expect(isBlacklisted(undefined)).toBe(false);
    expect(isBlacklisted("")).toBe(false);
    expect(isBlacklisted("   ")).toBe(false);
  });

  it("trims whitespace before comparing", () => {
    const addr = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
    expect(isBlacklisted(`  ${addr}\n`)).toBe(true);
  });

  it("is case-sensitive (Solana base58 is case-sensitive)", () => {
    const addr = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
    expect(isBlacklisted(addr.toLowerCase())).toBe(false);
    expect(isBlacklisted(addr)).toBe(true);
  });

  it("lookupBlacklist returns reason + sanction date", () => {
    const match = lookupBlacklist("0x722122dF12D4e14e13Ac3b6895a86e84145b6967");
    expect(match).not.toBeNull();
    expect(match!.reason).toMatch(/Tornado Cash/);
    expect(match!.sanctionedOn).toBe("2022-08-08");
    expect(match!.list).toBe("ofac:sdn");
  });

  it("OFAC_BLACKLIST_EXTRA env var extends the list", () => {
    const customWallet = Keypair.generate().publicKey.toBase58();
    process.env.OFAC_BLACKLIST_EXTRA = `${customWallet}|operator-flagged mixer`;
    resetBlacklistCache();
    expect(isBlacklisted(customWallet)).toBe(true);
    const match = lookupBlacklist(customWallet);
    expect(match?.reason).toBe("operator-flagged mixer");
    expect(match?.list).toBe("internal");
  });

  it("OFAC_BLACKLIST_EXTRA accepts comma-separated bare addresses", () => {
    const a = Keypair.generate().publicKey.toBase58();
    const b = Keypair.generate().publicKey.toBase58();
    process.env.OFAC_BLACKLIST_EXTRA = `${a}, ${b}`;
    resetBlacklistCache();
    expect(isBlacklisted(a)).toBe(true);
    expect(isBlacklisted(b)).toBe(true);
  });

  it("OFAC_BLACKLIST_EXTRA ignores empty/whitespace entries", () => {
    process.env.OFAC_BLACKLIST_EXTRA = ",, ,  ,";
    resetBlacklistCache();
    // Seed list still loaded.
    expect(listBlacklistEntries().length).toBeGreaterThanOrEqual(7);
  });
});

describe("enforceBlacklist", () => {
  let db: Db;
  let merchantId: string;
  let merchantWallet: string;

  beforeEach(() => {
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
    closeDatabase();
    db = openDatabase(":memory:");
    merchantWallet = Keypair.generate().publicKey.toBase58();
    const merchant = registerMerchant(db, {
      name: "Sanctions Test Co",
      walletAddress: merchantWallet,
      email: `sanctions-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
  });

  afterEach(() => {
    closeDatabase();
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
  });

  it("passes through when neither wallet is sanctioned", () => {
    const payerWallet = Keypair.generate().publicKey.toBase58();
    expect(() =>
      enforceBlacklist(db, {
        payerWallet,
        merchantWallet,
        merchantId,
      }),
    ).not.toThrow();
  });

  it("throws 403 forbidden when payer wallet is sanctioned", () => {
    const sanctionedPayer = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
    let caught: HttpError | null = null;
    try {
      enforceBlacklist(db, {
        payerWallet: sanctionedPayer,
        merchantWallet,
        merchantId,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(403);
    expect(caught?.code).toBe("forbidden");
    const details = caught?.details as { scope: string; role: string; walletAddress: string };
    expect(details.scope).toBe("blacklist:ofac");
    expect(details.role).toBe("payer");
    expect(details.walletAddress).toBe(sanctionedPayer);
  });

  it("throws 403 forbidden when merchant wallet is sanctioned", () => {
    const sanctioned = "0x8589427373D6D84E98730D7795D8f6f8731FDA16";
    process.env.OFAC_BLACKLIST_EXTRA = `${merchantWallet}|seeded for test`;
    resetBlacklistCache();
    let caught: HttpError | null = null;
    try {
      enforceBlacklist(db, {
        payerWallet: Keypair.generate().publicKey.toBase58(),
        merchantWallet,
        merchantId,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught?.status).toBe(403);
    const details = caught?.details as { role: string };
    expect(details.role).toBe("merchant");
    // Sanity: seeded address is still blocked too — proves seed list survives env-extras.
    expect(isBlacklisted(sanctioned)).toBe(true);
  });

  it("attributes payer ahead of merchant when both are sanctioned", () => {
    const sanctionedPayer = "0xDD4c48C0B24039969fC16D1cdF626eaB821d3384";
    process.env.OFAC_BLACKLIST_EXTRA = `${merchantWallet}|seeded merchant`;
    resetBlacklistCache();
    let caught: HttpError | null = null;
    try {
      enforceBlacklist(db, {
        payerWallet: sanctionedPayer,
        merchantWallet,
        merchantId,
      });
    } catch (err) {
      caught = err as HttpError;
    }
    const details = caught?.details as { role: string };
    expect(details.role).toBe("payer");
  });

  it("writes payment.blocked.blacklist audit entry on rejection", () => {
    const sanctioned = "0xd90e2f925DA726b50C4Ed8D0Fb90Ad053324F31b";
    expect(() =>
      enforceBlacklist(db, {
        payerWallet: sanctioned,
        merchantWallet,
        merchantId,
        paymentId: "pay_test_1",
      }),
    ).toThrow(HttpError);
    const audits = listAuditEntries(db, { event: "payment.blocked.blacklist" });
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor).toBe(`payer:${sanctioned}`);
    expect(audits[0]!.entityId).toBe(merchantId);
    const payload = audits[0]!.payload as {
      scope: string;
      role: string;
      walletAddress: string;
      paymentId?: string;
    };
    expect(payload.scope).toBe("blacklist:ofac");
    expect(payload.role).toBe("payer");
    expect(payload.paymentId).toBe("pay_test_1");
  });
});

describe("POST /pay blacklist integration", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;

  beforeEach(async () => {
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    const merchant = registerMerchant(db, {
      name: "Integ Sanctions Co",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `integ-sanctions-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    const solana = makeFakeSolana(payerKp);
    const app = createApp({ db, solana });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
    delete process.env.OFAC_BLACKLIST_EXTRA;
    resetBlacklistCache();
  });

  it("rejects POST /pay with 403 when payer is on the OFAC list", async () => {
    const sanctionedPayer = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1, payerWallet: sanctionedPayer }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as {
      error: { code: string; message: string; details?: { scope: string; role: string } };
    };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.details?.scope).toBe("blacklist:ofac");
    expect(body.error.details?.role).toBe("payer");
    expect(body.error.message).toMatch(/sanctions list/i);
  });

  it("rejects POST /pay with 403 when merchant wallet is on the OFAC list", async () => {
    // Seed the registered merchant's wallet via the env-extra path.
    const merchant = findMerchantById(db, merchantId)!;
    process.env.OFAC_BLACKLIST_EXTRA = `${merchant.walletAddress}|seeded for test`;
    resetBlacklistCache();
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { details?: { role: string } } };
    expect(body.error.details?.role).toBe("merchant");
  });

  it("does NOT count blocked attempts against velocity limits", async () => {
    const sanctionedPayer = "0x722122dF12D4e14e13Ac3b6895a86e84145b6967";
    // 10 blocked attempts — would burn through the 5/min velocity cap if counted.
    for (let i = 0; i < 10; i += 1) {
      const blocked = await fetch(`${server.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amount: 1, payerWallet: sanctionedPayer }),
      });
      expect(blocked.status).toBe(403);
    }
    // A clean payer can still make payments — no velocity slot was consumed.
    const cleanPayer = Keypair.generate().publicKey.toBase58();
    const ok = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1, payerWallet: cleanPayer }),
    });
    expect(ok.status).toBe(201);
  });

  it("records audit entry when /pay rejects via blacklist", async () => {
    const sanctionedPayer = "0x4736dCf1b7A3d580672CcE6E7c65cd5cc9cFBa9D";
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amount: 1, payerWallet: sanctionedPayer }),
    });
    expect(res.status).toBe(403);
    const audits = listAuditEntries(db, { event: "payment.blocked.blacklist" });
    expect(audits.length).toBe(1);
    expect(audits[0]!.actor).toBe(`payer:${sanctionedPayer}`);
  });

  it("allows POST /pay through when no wallet is sanctioned", async () => {
    const res = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId,
        amount: 1,
        payerWallet: Keypair.generate().publicKey.toBase58(),
      }),
    });
    expect(res.status).toBe(201);
  });
});
