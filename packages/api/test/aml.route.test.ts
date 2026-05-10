import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { Keypair } from "@solana/web3.js";
import type { Database as Db } from "better-sqlite3";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  insertPayment,
  markPaymentCompleted,
  getPayment,
} from "../src/db/payments.js";
import { evaluatePayment } from "../src/services/aml.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in aml route tests");
  },
} as unknown as SolanaService;

interface RegisteredMerchant {
  id: string;
  apiKey: string;
}

async function registerMerchantHttp(url: string): Promise<RegisteredMerchant> {
  const wallet = Keypair.generate().publicKey.toBase58();
  const res = await fetch(`${url}/merchants/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "AML Co",
      walletAddress: wallet,
      email: `aml-${Math.random().toString(36).slice(2)}@test.local`,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { merchant: RegisteredMerchant };
  return body.merchant;
}

describe("aml routes", () => {
  let db: Db;
  let url: string;
  let close: () => Promise<void>;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({
      db,
      solana: dummySolana,
      // Disable env-based config to keep tests deterministic.
      amlConfig: null,
    });
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

  function seedAlertViaService(merchantId: string, payerWallet: string): string {
    const id = `pay_route_${Math.random().toString(36).slice(2)}`;
    insertPayment(db, {
      id,
      merchantId,
      amountUsdc: 9_500,
      payerWallet,
      metadata: null,
    });
    markPaymentCompleted(db, id, `sig_${id}`);
    const { alerts } = evaluatePayment(db, { payment: getPayment(db, id) });
    return alerts.find((a) => a.rule === "high_amount")!.id;
  }

  it("rejects calls without API key", async () => {
    const merchant = await registerMerchantHttp(url);
    const res = await fetch(`${url}/merchants/${merchant.id}/aml/alerts`);
    expect(res.status).toBe(401);
  });

  it("returns alerts for the authenticated merchant", async () => {
    const merchant = await registerMerchantHttp(url);
    const payerWallet = Keypair.generate().publicKey.toBase58();
    seedAlertViaService(merchant.id, payerWallet);

    const res = await fetch(`${url}/merchants/${merchant.id}/aml/alerts`, {
      headers: { "x-zettapay-api-key": merchant.apiKey },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alerts: Array<{ id: string; rule: string; status: string }>;
    };
    expect(body.alerts.length).toBeGreaterThan(0);
    expect(body.alerts[0]!.rule).toBe("high_amount");
    expect(body.alerts[0]!.status).toBe("open");
  });

  it("filters alerts by status query", async () => {
    const merchant = await registerMerchantHttp(url);
    seedAlertViaService(merchant.id, Keypair.generate().publicKey.toBase58());

    const dismissed = await fetch(
      `${url}/merchants/${merchant.id}/aml/alerts?status=dismissed`,
      { headers: { "x-zettapay-api-key": merchant.apiKey } },
    );
    const body = (await dismissed.json()) as { alerts: unknown[] };
    expect(body.alerts).toHaveLength(0);
  });

  it("transitions an alert via review endpoint", async () => {
    const merchant = await registerMerchantHttp(url);
    const alertId = seedAlertViaService(
      merchant.id,
      Keypair.generate().publicKey.toBase58(),
    );

    const res = await fetch(
      `${url}/merchants/${merchant.id}/aml/alerts/${alertId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify({
          status: "dismissed",
          reviewedBy: "compliance@zettapay.io",
          notes: "False positive",
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alert: { status: string; reviewedBy: string };
    };
    expect(body.alert.status).toBe("dismissed");
    expect(body.alert.reviewedBy).toBe("compliance@zettapay.io");
  });

  it("rejects review with invalid status value", async () => {
    const merchant = await registerMerchantHttp(url);
    const alertId = seedAlertViaService(
      merchant.id,
      Keypair.generate().publicKey.toBase58(),
    );

    const res = await fetch(
      `${url}/merchants/${merchant.id}/aml/alerts/${alertId}/review`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify({
          status: "open",
          reviewedBy: "x@y.z",
        }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("creates and lists SARs through the route", async () => {
    const merchant = await registerMerchantHttp(url);
    const payerWallet = Keypair.generate().publicKey.toBase58();
    const alertId = seedAlertViaService(merchant.id, payerWallet);

    const createRes = await fetch(
      `${url}/merchants/${merchant.id}/aml/sars`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify({
          alertIds: [alertId],
          narrative:
            "Payer triggered structuring + high-amount thresholds within 24h",
          filedBy: "compliance@zettapay.io",
        }),
      },
    );
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as {
      sar: { id: string; status: string; reference: string };
    };
    expect(created.sar.status).toBe("draft");

    const listRes = await fetch(`${url}/merchants/${merchant.id}/aml/sars`, {
      headers: { "x-zettapay-api-key": merchant.apiKey },
    });
    const list = (await listRes.json()) as { sars: Array<{ id: string }> };
    expect(list.sars.length).toBe(1);
    expect(list.sars[0]!.id).toBe(created.sar.id);

    const fileRes = await fetch(
      `${url}/merchants/${merchant.id}/aml/sars/${created.sar.id}/file`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify({
          filedBy: "compliance@zettapay.io",
          externalFilingId: "FINCEN-2026-99999",
        }),
      },
    );
    expect(fileRes.status).toBe(200);
    const filed = (await fileRes.json()) as { sar: { status: string } };
    expect(filed.sar.status).toBe("filed");
  });

  it("rejects SAR creation with empty alertIds", async () => {
    const merchant = await registerMerchantHttp(url);
    const res = await fetch(`${url}/merchants/${merchant.id}/aml/sars`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify({
        alertIds: [],
        narrative: "n",
        filedBy: "x@y.z",
      }),
    });
    expect(res.status).toBe(400);
  });
});
