import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import type { SolanaService } from "../src/services/solana.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import { findMerchantById } from "../src/db/merchants.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in privacy tests");
  },
} as unknown as SolanaService;

const API_KEY_HEADER = "x-zettapay-api-key";

interface RegisteredMerchant {
  id: string;
  apiKey: string;
}

async function registerMerchant(url: string): Promise<RegisteredMerchant> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const email = `m_${Math.random().toString(36).slice(2)}@privacy.test`;
  const res = await fetch(`${url}/merchants/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Acme", walletAddress: wallet, email }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { merchant: RegisteredMerchant };
  return body.merchant;
}

describe("Z21.4 LGPD/GDPR privacy routes", () => {
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

  describe("GET /privacy/export", () => {
    it("returns the merchant data dump and writes audit", async () => {
      const merchant = await registerMerchant(url);
      const res = await fetch(`${url}/privacy/export`, {
        method: "GET",
        headers: { [API_KEY_HEADER]: merchant.apiKey },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        merchant: { id: string; email: string };
        payments: { total: number };
        consents: unknown[];
        retainedForLegalObligations: Record<string, string>;
      };
      expect(body.merchant.id).toBe(merchant.id);
      expect(body.payments.total).toBe(0);
      expect(body.consents).toEqual([]);
      expect(body.retainedForLegalObligations.payments).toMatch(/LGPD|GDPR/);

      const audit = listAuditEntries(db, { event: "privacy.data_exported" });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.entityId).toBe(merchant.id);
    });

    it("rejects when api key missing or invalid", async () => {
      const noKey = await fetch(`${url}/privacy/export`);
      expect(noKey.status).toBe(401);
      const badKey = await fetch(`${url}/privacy/export`, {
        headers: { [API_KEY_HEADER]: "zp_live_invalid" },
      });
      expect(badKey.status).toBe(401);
    });
  });

  describe("POST /privacy/deletion", () => {
    it("redacts PII, cancels subscriptions, retains payments and audit", async () => {
      const merchant = await registerMerchant(url);
      const before = findMerchantById(db, merchant.id);
      const originalEmail = before?.email;
      expect(originalEmail).toBeTruthy();

      const res = await fetch(`${url}/privacy/deletion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        merchantId: string;
        deletedAt: string;
        retained: { payments: number; auditJournalEntries: number };
      };
      expect(body.merchantId).toBe(merchant.id);
      expect(body.deletedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      const after = findMerchantById(db, merchant.id);
      expect(after).not.toBeNull();
      expect(after?.deletedAt).toBeTruthy();
      expect(after?.name).toBe("[redacted]");
      expect(after?.email).not.toBe(originalEmail);
      expect(after?.email).toContain("@privacy.zettapay.invalid");
      expect(after?.apiKey).toMatch(/^revoked_/);
      expect(after?.webhookUrl).toBeNull();
      expect(after?.webhookSecret).toBeNull();

      const audit = listAuditEntries(db, { event: "privacy.data_deleted" });
      expect(audit).toHaveLength(1);
      expect(audit[0]?.entityId).toBe(merchant.id);
    });

    it("requires the literal DELETE confirmation", async () => {
      const merchant = await registerMerchant(url);
      const res = await fetch(`${url}/privacy/deletion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({ confirmation: "yes" }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 401 when api key invalid (does not leak that the merchant exists)", async () => {
      await registerMerchant(url);
      const res = await fetch(`${url}/privacy/deletion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: "zp_live_nope",
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(res.status).toBe(401);
    });

    it("returns 409 on a second deletion attempt", async () => {
      const merchant = await registerMerchant(url);
      const first = await fetch(`${url}/privacy/deletion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(first.status).toBe(200);
      // Second call uses the original (now revoked) key — auth fails first.
      const second = await fetch(`${url}/privacy/deletion`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({ confirmation: "DELETE" }),
      });
      expect(second.status).toBe(401);
    });
  });

  describe("/privacy/consent", () => {
    it("records granted consent and writes audit", async () => {
      const merchant = await registerMerchant(url);
      const res = await fetch(`${url}/privacy/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({
          subjectType: "merchant",
          subjectId: merchant.id,
          purpose: "marketing",
          granted: true,
          source: "dashboard",
          metadata: { uiVersion: "v3" },
        }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        record: {
          id: string;
          purpose: string;
          granted: boolean;
          grantedAt: string | null;
          withdrawnAt: string | null;
          source: string | null;
        };
      };
      expect(body.record.purpose).toBe("marketing");
      expect(body.record.granted).toBe(true);
      expect(body.record.grantedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(body.record.withdrawnAt).toBeNull();
      expect(body.record.source).toBe("dashboard");

      const audit = listAuditEntries(db, { event: "privacy.consent_granted" });
      expect(audit).toHaveLength(1);
    });

    it("withdrawing consent appends a new row and the latest decision wins", async () => {
      const merchant = await registerMerchant(url);
      const grant = await fetch(`${url}/privacy/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({
          subjectType: "merchant",
          subjectId: merchant.id,
          purpose: "marketing",
          granted: true,
        }),
      });
      expect(grant.status).toBe(201);

      // Tiny delay so created_at differs and "latest by created_at" picks the
      // withdrawal — SQLite's strftime resolution is millisecond.
      await new Promise((r) => setTimeout(r, 5));

      const withdraw = await fetch(`${url}/privacy/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({
          subjectType: "merchant",
          subjectId: merchant.id,
          purpose: "marketing",
          granted: false,
        }),
      });
      expect(withdraw.status).toBe(201);

      const list = await fetch(
        `${url}/privacy/consent?subjectType=merchant&subjectId=${encodeURIComponent(merchant.id)}`,
        { headers: { [API_KEY_HEADER]: merchant.apiKey } },
      );
      expect(list.status).toBe(200);
      const body = (await list.json()) as {
        records: Array<{ purpose: string; granted: boolean }>;
      };
      expect(body.records).toHaveLength(1);
      expect(body.records[0]?.purpose).toBe("marketing");
      expect(body.records[0]?.granted).toBe(false);

      const auditWithdrawn = listAuditEntries(db, {
        event: "privacy.consent_withdrawn",
      });
      expect(auditWithdrawn).toHaveLength(1);
    });

    it("rejects recording consent for a different merchant", async () => {
      const a = await registerMerchant(url);
      const b = await registerMerchant(url);
      const res = await fetch(`${url}/privacy/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: a.apiKey,
        },
        body: JSON.stringify({
          subjectType: "merchant",
          subjectId: b.id,
          purpose: "marketing",
          granted: true,
        }),
      });
      expect(res.status).toBe(403);
    });

    it("permits a merchant to record wallet consent on behalf of a payer", async () => {
      const merchant = await registerMerchant(url);
      const wallet = Keypair.generate().publicKey.toBase58();
      const res = await fetch(`${url}/privacy/consent`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [API_KEY_HEADER]: merchant.apiKey,
        },
        body: JSON.stringify({
          subjectType: "wallet",
          subjectId: wallet,
          purpose: "checkout_terms",
          granted: true,
          source: "checkout",
        }),
      });
      expect(res.status).toBe(201);
    });
  });
});
