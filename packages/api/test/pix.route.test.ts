import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair, PublicKey } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import { findMerchantById } from "../src/db/merchants.js";
import {
  findPixSettlementByPayment,
  listPixSettlementsByMerchant,
} from "../src/db/pix_settlements.js";
import type { SolanaService } from "../src/services/solana.js";
import type {
  PixClient,
  PixProvider,
  PixWithdrawalRequest,
  PixWithdrawalResponse,
} from "../src/pix/client.js";

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
    transferToken: vi.fn(
      async (params: { recipientOwner: PublicKey; amount: number }) => ({
        signature: `sig_${params.recipientOwner.toBase58().slice(0, 6)}_${params.amount}`,
        payerWallet: payerKp.publicKey.toBase58(),
        recipientWallet: params.recipientOwner.toBase58(),
        amountAtomic: BigInt(Math.round(params.amount * 1_000_000)),
        decimals: 6,
      }),
    ),
  } as unknown as SolanaService;
}

interface FakePixClientHandle {
  client: PixClient;
  calls: PixWithdrawalRequest[];
}

function makeFakePixClient(
  provider: PixProvider,
  override?: Partial<PixWithdrawalResponse>,
): FakePixClientHandle {
  const calls: PixWithdrawalRequest[] = [];
  return {
    calls,
    client: {
      provider,
      createWithdrawal: vi.fn(
        async (req: PixWithdrawalRequest): Promise<PixWithdrawalResponse> => {
          calls.push(req);
          return {
            withdrawalId: `${provider}_w_${calls.length}`,
            status: "completed",
            provider,
            quotedBrl: req.netUsdc * 5, // stub BRL quote
            expectedSettlementAt: null,
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

describe("Pix settlement routes", () => {
  let db: Db;
  let server: RunningServer;
  let merchantId: string;
  let payerKp: Keypair;
  let bitpreco: FakePixClientHandle;
  let transfero: FakePixClientHandle;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    payerKp = Keypair.generate();
    const merchant = registerMerchant(db, {
      name: "Padaria Pão Quente MEI",
      walletAddress: Keypair.generate().publicKey.toBase58(),
      email: `mei-${Date.now()}-${Math.random()}@example.com.br`,
      webhookUrl: null,
    });
    merchantId = merchant.id;
    bitpreco = makeFakePixClient("bitpreco");
    transfero = makeFakePixClient("transfero");
    const app = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      pix: {
        availableProviders: ["bitpreco", "transfero"],
        resolveClient: (provider) =>
          provider === "bitpreco"
            ? bitpreco.client
            : provider === "transfero"
              ? transfero.client
              : undefined,
      },
    });
    server = await startApp(app);
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("opt-in persists Pix settings and echoes the published fee bps", async () => {
    const res = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "bitpreco",
          pixKey: "12345678900",
          pixKeyType: "cpf",
          autoSettle: true,
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      merchantId: string;
      pix: {
        enabled: boolean;
        autoSettle: boolean;
        provider: string;
        pixKey: string;
        pixKeyType: string;
      };
      feeBps: number;
      availableProviders: string[];
    };
    expect(body.feeBps).toBe(150);
    expect(body.pix.enabled).toBe(true);
    expect(body.pix.autoSettle).toBe(true);
    expect(body.pix.provider).toBe("bitpreco");
    expect(body.pix.pixKeyType).toBe("cpf");
    expect(body.availableProviders).toEqual(
      expect.arrayContaining(["bitpreco", "transfero"]),
    );

    const persisted = findMerchantById(db, merchantId);
    expect(persisted?.pix.pixKey).toBe("12345678900");
  });

  it("rejects unknown providers and unknown pix key types", async () => {
    const badProvider = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "stripe",
          pixKey: "x",
          pixKeyType: "cpf",
        }),
      },
    );
    expect(badProvider.status).toBe(400);

    const badKeyType = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "bitpreco",
          pixKey: "x",
          pixKeyType: "iban",
        }),
      },
    );
    expect(badKeyType.status).toBe(400);
  });

  it("opt-out clears Pix settings", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/pix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "transfero",
        pixKey: "merchant@example.com",
        pixKeyType: "email",
      }),
    });
    const del = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(204);
    const merchant = findMerchantById(db, merchantId);
    expect(merchant?.pix.enabled).toBe(false);
    expect(merchant?.pix.pixKey).toBeNull();
    expect(merchant?.pix.provider).toBeNull();
  });

  it("auto-settles via the configured provider on /pay when autoSettle is on", async () => {
    let settledPaymentId: string | null = null;
    const app2 = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      pix: {
        availableProviders: ["bitpreco", "transfero"],
        resolveClient: (provider) =>
          provider === "bitpreco"
            ? bitpreco.client
            : provider === "transfero"
              ? transfero.client
              : undefined,
      },
      onAutoPixSettle: (paymentId, err) => {
        if (!err) settledPaymentId = paymentId;
      },
    });
    const server2 = await startApp(app2);
    try {
      await fetch(`${server2.url}/merchants/${merchantId}/settlement/pix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "transfero",
          pixKey: "12345678900",
          pixKeyType: "cpf",
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

      const settlement = findPixSettlementByPayment(db, payBody.payment.id);
      expect(settlement).not.toBeNull();
      expect(settlement?.status).toBe("completed");
      expect(settlement?.provider).toBe("transfero");
      expect(settlement?.feeUsdc).toBe(3); // 200 * 1.5%
      expect(settlement?.netUsdc).toBe(197);
      expect(settlement?.feeBps).toBe(150);
      // BRL quote stored from stubbed provider response
      expect(settlement?.quotedBrl).toBe(197 * 5);
      expect(transfero.calls).toHaveLength(1);
      expect(transfero.calls[0]?.netUsdc).toBe(197);
      expect(transfero.calls[0]?.idempotencyKey).toBe(settlement?.id);
      // The bitpreco client should NOT be invoked
      expect(bitpreco.calls).toHaveLength(0);
    } finally {
      await server2.close();
    }
  });

  it("does NOT auto-settle when autoSettle is false", async () => {
    let invoked = false;
    const app2 = createApp({
      db,
      solana: makeFakeSolana(payerKp),
      pix: {
        availableProviders: ["bitpreco", "transfero"],
        resolveClient: (provider) =>
          provider === "bitpreco" ? bitpreco.client : transfero.client,
      },
      onAutoPixSettle: () => {
        invoked = true;
      },
    });
    const server2 = await startApp(app2);
    try {
      await fetch(`${server2.url}/merchants/${merchantId}/settlement/pix`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "bitpreco",
          pixKey: "12345678900",
          pixKeyType: "cpf",
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

      await new Promise((r) => setTimeout(r, 50));
      expect(invoked).toBe(false);
      expect(findPixSettlementByPayment(db, payBody.payment.id)).toBeNull();
    } finally {
      await server2.close();
    }
  });

  it("manual settle endpoint settles a completed payment", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/pix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "bitpreco",
        pixKey: "merchant@example.com",
        pixKeyType: "email",
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
      `${server.url}/merchants/${merchantId}/settlement/pix/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(settleRes.status).toBe(201);
    const body = (await settleRes.json()) as {
      settlement: {
        provider: string;
        status: string;
        netUsdc: number;
        feeUsdc: number;
      };
    };
    expect(body.settlement.status).toBe("completed");
    expect(body.settlement.provider).toBe("bitpreco");
    expect(body.settlement.feeUsdc).toBe(0.375); // 25 * 1.5%
    expect(body.settlement.netUsdc).toBe(24.625);

    const list = listPixSettlementsByMerchant(db, merchantId);
    expect(list).toHaveLength(1);
  });

  it("manual settle is idempotent at the payment level", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/pix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "bitpreco",
        pixKey: "12345678900",
        pixKeyType: "cpf",
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
      `${server.url}/merchants/${merchantId}/settlement/pix/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(first.status).toBe(201);
    const second = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(second.status).toBe(201);

    expect(bitpreco.calls).toHaveLength(1);
    expect(listPixSettlementsByMerchant(db, merchantId)).toHaveLength(1);
  });

  it("rejects manual settle when merchant has not opted in", async () => {
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 5 }),
    });
    const payBody = (await payRes.json()) as { payment: { id: string } };

    const res = await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    expect(res.status).toBe(400);
  });

  it("GET /merchants/:id/pix-settlements lists merchant settlements", async () => {
    await fetch(`${server.url}/merchants/${merchantId}/settlement/pix`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "bitpreco",
        pixKey: "12345678900",
        pixKeyType: "cpf",
        autoSettle: false,
      }),
    });
    const payRes = await fetch(`${server.url}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchantId, amountUsdc: 7.5 }),
    });
    const payBody = (await payRes.json()) as { payment: { id: string } };
    await fetch(
      `${server.url}/merchants/${merchantId}/settlement/pix/payments/${payBody.payment.id}`,
      { method: "POST" },
    );
    const list = await fetch(
      `${server.url}/merchants/${merchantId}/pix-settlements`,
    );
    expect(list.status).toBe(200);
    const body = (await list.json()) as {
      settlements: Array<{ provider: string; status: string }>;
      feeBps: number;
    };
    expect(body.feeBps).toBe(150);
    expect(body.settlements).toHaveLength(1);
    expect(body.settlements[0]?.provider).toBe("bitpreco");
  });
});
