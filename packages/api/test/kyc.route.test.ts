import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import { Keypair } from "@solana/web3.js";
import type { Database as Db } from "better-sqlite3";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { listAuditEntries } from "../src/db/audit_journal.js";
import type {
  AccessTokenInput,
  AccessTokenResult,
  CreateApplicantInput,
  CreateApplicantResult,
  KycProviderClient,
  WebhookVerifyResult,
} from "../src/services/kyc/provider.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in kyc tests");
  },
} as unknown as SolanaService;

const WEBHOOK_SECRET = "whsec_kyc_test_secret_aaaaaaaaaaaaaaaaaaaa";

interface StubState {
  applicantSeq: number;
  tokenSeq: number;
  applicants: CreateApplicantInput[];
  tokens: AccessTokenInput[];
}

function createStubProvider(state: StubState): KycProviderClient {
  return {
    name: "sumsub",
    async createApplicant(input: CreateApplicantInput): Promise<CreateApplicantResult> {
      state.applicants.push(input);
      state.applicantSeq += 1;
      return { applicantId: `appl_test_${state.applicantSeq}` };
    },
    async issueAccessToken(input: AccessTokenInput): Promise<AccessTokenResult> {
      state.tokens.push(input);
      state.tokenSeq += 1;
      return {
        token: `tok_test_${state.tokenSeq}`,
        userId: input.externalUserId,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      };
    },
    verifyWebhook({ rawBody, headers }): WebhookVerifyResult {
      const provided =
        (headers["x-payload-digest"] as string | undefined) ?? null;
      if (!provided) return { valid: false, reason: "missing_digest" };
      const expected = createHmac("sha256", WEBHOOK_SECRET)
        .update(rawBody)
        .digest("hex");
      return provided === expected
        ? { valid: true }
        : { valid: false, reason: "signature_mismatch" };
    },
  };
}

interface RegisteredMerchant {
  id: string;
  apiKey: string;
}

async function registerMerchant(url: string): Promise<RegisteredMerchant> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const res = await fetch(`${url}/merchants/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "KYC Co",
      walletAddress: wallet,
      email: `kyc-${Math.random().toString(36).slice(2)}@test.local`,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { merchant: RegisteredMerchant };
  return body.merchant;
}

describe("kyc routes", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;
  let stub: StubState;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    stub = { applicantSeq: 0, tokenSeq: 0, applicants: [], tokens: [] };
    const provider = createStubProvider(stub);
    const app = createApp({ db, solana: dummySolana, kyc: provider });
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

  it("starts a verification, records a document, and reports status", async () => {
    const merchant = await registerMerchant(url);

    const startRes = await fetch(`${url}/merchants/${merchant.id}/kyc/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({}),
    });
    expect(startRes.status).toBe(201);
    const startBody = (await startRes.json()) as {
      verification: { id: string; status: string; applicantId: string };
      accessToken: { token: string; userId: string };
    };
    expect(startBody.verification.status).toBe("pending");
    expect(startBody.verification.applicantId).toMatch(/^appl_test_/);
    expect(startBody.accessToken.token).toMatch(/^tok_test_/);
    expect(stub.applicants).toHaveLength(1);
    expect(stub.applicants[0]?.externalUserId).toBe(merchant.id);

    const docRes = await fetch(
      `${url}/merchants/${merchant.id}/kyc/documents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify({
          docType: "ID_CARD",
          docSubtype: "FRONT_SIDE",
          fileName: "id-front.jpg",
          mimeType: "image/jpeg",
          sizeBytes: 84210,
          externalRef: "imageId-1234",
        }),
      },
    );
    expect(docRes.status).toBe(201);
    const docBody = (await docRes.json()) as {
      verification: { status: string };
      document: { id: string; docType: string };
    };
    expect(docBody.verification.status).toBe("in_review");
    expect(docBody.document.docType).toBe("ID_CARD");

    const statusRes = await fetch(
      `${url}/merchants/${merchant.id}/kyc/status`,
      {
        headers: { "x-zettapay-api-key": merchant.apiKey },
      },
    );
    expect(statusRes.status).toBe(200);
    const statusBody = (await statusRes.json()) as {
      verification: { status: string };
      documents: Array<{ docType: string }>;
    };
    expect(statusBody.verification.status).toBe("in_review");
    expect(statusBody.documents).toHaveLength(1);
  });

  it("rejects start with a bad api key", async () => {
    const merchant = await registerMerchant(url);
    const res = await fetch(`${url}/merchants/${merchant.id}/kyc/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": "bad-key",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects start when the api key belongs to a different merchant", async () => {
    const a = await registerMerchant(url);
    const b = await registerMerchant(url);
    const res = await fetch(`${url}/merchants/${a.id}/kyc/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": b.apiKey,
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("returns null verification on status when KYC not started", async () => {
    const merchant = await registerMerchant(url);
    const res = await fetch(`${url}/merchants/${merchant.id}/kyc/status`, {
      headers: { "x-zettapay-api-key": merchant.apiKey },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { verification: unknown; documents: unknown[] };
    expect(body.verification).toBeNull();
    expect(body.documents).toHaveLength(0);
  });

  it("processes a signed approve webhook and updates state", async () => {
    const merchant = await registerMerchant(url);
    await fetch(`${url}/merchants/${merchant.id}/kyc/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({}),
    });

    const payload = {
      type: "applicantReviewed",
      applicantId: "appl_test_1",
      externalUserId: merchant.id,
      reviewResult: { reviewAnswer: "GREEN" },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");

    const res = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payload-digest": sig,
        "x-payload-digest-alg": "HMAC_SHA256_HEX",
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      status: string;
    };
    expect(body.changed).toBe(true);
    expect(body.status).toBe("approved");

    const statusRes = await fetch(
      `${url}/merchants/${merchant.id}/kyc/status`,
      { headers: { "x-zettapay-api-key": merchant.apiKey } },
    );
    const statusBody = (await statusRes.json()) as {
      verification: { status: string; reviewAnswer: string | null };
    };
    expect(statusBody.verification.status).toBe("approved");
    expect(statusBody.verification.reviewAnswer).toBe("GREEN");

    // Audit trail must include the verification.updated event.
    const auditEvents = listAuditEntries(db, {
      event: "kyc.verification.updated",
    });
    expect(auditEvents.length).toBeGreaterThan(0);
  });

  it("rejects an unsigned webhook with 401", async () => {
    const res = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "applicantReviewed" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a webhook with a tampered signature", async () => {
    const payload = { type: "applicantPending", applicantId: "appl_test_1" };
    const raw = Buffer.from(JSON.stringify(payload));
    const goodSig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const tampered = Buffer.from(JSON.stringify({ ...payload, type: "applicantReviewed" }));

    const res = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payload-digest": goodSig,
        "x-payload-digest-alg": "HMAC_SHA256_HEX",
      },
      body: tampered,
    });
    expect(res.status).toBe(401);
  });

  it("treats duplicate webhook deliveries as no-ops with changed=false", async () => {
    const merchant = await registerMerchant(url);
    await fetch(`${url}/merchants/${merchant.id}/kyc/start`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({}),
    });

    const payload = {
      type: "applicantReviewed",
      applicantId: "appl_test_1",
      externalUserId: merchant.id,
      reviewResult: { reviewAnswer: "GREEN" },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const headers = {
      "content-type": "application/json",
      "x-payload-digest": sig,
      "x-payload-digest-alg": "HMAC_SHA256_HEX",
    };

    const first = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers,
      body: raw,
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { changed: boolean };
    expect(firstBody.changed).toBe(true);

    const second = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers,
      body: raw,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { changed: boolean };
    expect(secondBody.changed).toBe(false);
  });

  it("ignores webhooks for unknown applicants but still 200s", async () => {
    const payload = {
      type: "applicantReviewed",
      applicantId: "appl_unknown_999",
      externalUserId: "merch_unknown",
      reviewResult: { reviewAnswer: "GREEN" },
    };
    const raw = Buffer.from(JSON.stringify(payload));
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(raw).digest("hex");
    const res = await fetch(`${url}/webhooks/sumsub`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payload-digest": sig,
        "x-payload-digest-alg": "HMAC_SHA256_HEX",
      },
      body: raw,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      changed: boolean;
      verificationId: string | null;
    };
    expect(body.changed).toBe(false);
    expect(body.verificationId).toBeNull();
  });

  it("503s on KYC endpoints when no provider is configured", async () => {
    // Spin up a second app without a kyc provider.
    closeDatabase();
    const localDb = openDatabase(":memory:");
    const localApp = createApp({ db: localDb, solana: dummySolana });
    const server = await new Promise<{
      close: () => Promise<void>;
      url: string;
    }>((resolve) => {
      const srv = localApp.listen(0, () => {
        const { port } = srv.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((r) => {
              srv.close(() => r());
            }),
        });
      });
    });

    try {
      const merchant = await registerMerchant(server.url);
      const startRes = await fetch(
        `${server.url}/merchants/${merchant.id}/kyc/start`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-zettapay-api-key": merchant.apiKey,
          },
          body: JSON.stringify({}),
        },
      );
      expect(startRes.status).toBe(503);

      const webhookRes = await fetch(`${server.url}/webhooks/sumsub`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(webhookRes.status).toBe(503);
    } finally {
      await server.close();
    }
  });
});
