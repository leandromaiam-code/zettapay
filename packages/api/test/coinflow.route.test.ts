import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { findMerchantById } from "../src/db/merchants.js";
import {
  findSettlementByPayment,
  listSettlementsByMerchant,
} from "../src/db/coinflow_settlements.js";
import type { SolanaService } from "../src/services/solana.js";
import type {
  CoinflowClient,
  CoinflowWithdrawalRequest,
  CoinflowWithdrawalResponse,
} from "../src/coinflow/client.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: ReturnType<typeof createApp>): Promise<RunningServer> {
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
    getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    transferUsdc: vi.fn(
      async (params: { recipientOwner: PublicKey; amountUsdc: number }) => ({
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amountUsdc}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amountUsdc * 1_000_000)),
        decimals: 6,
      }),
    ),
  } as unknown as SolanaService;
}

function makeFakeCoinflow(
  override?: Partial<CoinflowWithdrawalResponse>,
): { client: CoinflowClient; calls: CoinflowWithdrawalRequest[] } {
  const calls: CoinflowWithdrawalRequest[] = [];
  return {
    calls,
    client: {
      createWithdrawal: vi.fn(
        async (req: CoinflowWithdrawalRequest): Promise<CoinflowWithdrawalResponse> => {
          calls.push(req);
          return {
            withdrawalId: `cfw_${calls.length}`,
            status: "completed",
            ...override,
          };
        },
      ),
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) {
        return reject(new Error("waitFor timed out"));
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("Coinflow settlement routes", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;
  let coinflow: ReturnType<typeof makeFakeCoinflow>;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    const merchant = registerMerchant(db, {
      name: "Acme Coffee",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `merchant-${Date.now()}-${Math.random()}@example.com`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    coinflow = makeFakeCoinflow();
    const app = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      coinflow: coinflow.client,
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("opt-in persists Coinflow settings and returns the published fee bps", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coinflowMerchantId: "cf_merch_42",
          bankAccountId: "ba_acct_1",
          autoSettle: true,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      coinflow: { enabled: boolean; autoSettle: boolean; bankAccountId: string };
      feeBps: number;
    };
    expect(body.feeBps).toBe(150);
    expect(body.coinflow.enabled).toBe(true);
    expect(body.coinflow.autoSettle).toBe(true);
    expect(body.coinflow.bankAccountId).toBe("ba_acct_1");

    const persisted = findMerchantById(db, merchantId);
    expect(persisted?.coinflow.coinflowMerchantId).toBe("cf_merch_42");
  });

  it("opt-out clears settings", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/coinflow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coinflowMerchantId: "cf_merch_42",
        bankAccountId: "ba_acct_1",
      }),
    });
    const del = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
    const merchant = findMerchantById(db, merchantId);
    expect(merchant?.coinflow.enabled).toBe(false);
    expect(merchant?.coinflow.bankAccountId).toBeNull();
  });

  it("auto-settles on /pay when merchant has auto-settle enabled", async () => {
    let settledPaymentId: string | null = null;
    const app2 = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      coinflow: coinflow.client,
      onAutoSettle: (paymentId, err) => {
        if (!err) settledPaymentId = paymentId;
      },
    });
    const server2 = await startApp(app2);
    try {
      await fetch(`${server2.url}/merchants/${merchantId}/settlement/coinflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coinflowMerchantId: "cf_merch_42",
          bankAccountId: "ba_acct_1",
          autoSettle: true,
        }),
      });

      const payRes = await fetch(`${server2.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amountUsdc: 200 }),
      });
      expect(payRes.status).toBe(201);
      const payBody = (await payRes.json()) as {
        payment: { id: string; status: string };
      };
      expect(payBody.payment.status).toBe("completed");

      await waitFor(() => settledPaymentId === payBody.payment.id);

      const settlement = findSettlementByPayment(db, payBody.payment.id);
      expect(settlement).not.toBeNull();
      expect(settlement?.status).toBe("completed");
      expect(settlement?.feeUsdc).toBe(3); // 200 * 1.5%
      expect(settlement?.netUsdc).toBe(197);
      expect(settlement?.feeBps).toBe(150);
      expect(coinflow.calls).toHaveLength(1);
      expect(coinflow.calls[0]?.netUsdc).toBe(197);
      expect(coinflow.calls[0]?.idempotencyKey).toBe(settlement?.id);
    } finally {
      await server2.close();
    }
  });

  it("does NOT auto-settle when autoSettle is false", async () => {
    let invoked = false;
    const app2 = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      coinflow: coinflow.client,
      onAutoSettle: () => {
        invoked = true;
      },
    });
    const server2 = await startApp(app2);
    try {
      await fetch(`${server2.url}/merchants/${merchantId}/settlement/coinflow`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          coinflowMerchantId: "cf_merch_42",
          bankAccountId: "ba_acct_1",
          autoSettle: false,
        }),
      });

      const payRes = await fetch(`${server2.url}/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchantId, amountUsdc: 50 }),
      });
      expect(payRes.status).toBe(201);
      const payBody = (await payRes.json()) as { payment: { id: string } };

      // Give the event loop a chance — auto-settle is fire-and-forget.
      await new Promise((r) => setTimeout(r, 50));
      expect(invoked).toBe(false);
      expect(findSettlementByPayment(db, payBody.payment.id)).toBeNull();
    } finally {
      await server2.close();
    }
  });

  it("manual settle endpoint settles a completed payment", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/coinflow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coinflowMerchantId: "cf_merch_42",
        bankAccountId: "ba_acct_1",
        autoSettle: false,
      }),
    });
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 25 }),
    });
    const payBody = (await payRes.json()) as { payment: { id: string } };

    const settleRes = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(settleRes.status).toBe(201);
    const body = (await settleRes.json()) as {
      settlement: { status: string; netUsdc: number; feeUsdc: number };
    };
    expect(body.settlement.status).toBe("completed");
    expect(body.settlement.feeUsdc).toBe(0.375); // 25 * 1.5%
    expect(body.settlement.netUsdc).toBe(24.625);

    const list = listSettlementsByMerchant(db, merchantId);
    expect(list).toHaveLength(1);
  });

  it("manual settle is idempotent at the payment level", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/coinflow`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        coinflowMerchantId: "cf_merch_42",
        bankAccountId: "ba_acct_1",
        autoSettle: false,
      }),
    });
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 10 }),
    });
    const payBody = (await payRes.json()) as { payment: { id: string } };

    const first = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(first.status).toBe(201);
    const second = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(second.status).toBe(201);

    expect(coinflow.calls).toHaveLength(1);
    expect(listSettlementsByMerchant(db, merchantId)).toHaveLength(1);
  });

  it("rejects manual settle when merchant has not opted in", async () => {
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 5 }),
    });
    const payBody = (await payRes.json()) as { payment: { id: string } };

    const res = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/coinflow/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });
});
