import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import { registerMerchant } from "../src/services/merchants.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in registry tests");
  },
} as unknown as SolanaService;

interface Server {
  url: string;
  close: () => Promise<void>;
}

async function startApp(app: ReturnType<typeof createApp>): Promise<Server> {
  return new Promise<Server>((resolve) => {
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

function makeMerchant(db: Db, label = "pub") {
  return registerMerchant(db, {
    name: `${label} co`,
    walletAddress: Keypair.generate().publicKey.toBase58(),
    email: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@test.com`,
    webhookUrl: null,
  });
}

const validBody = (overrides: Record<string, unknown> = {}) => ({
  slug: "weather-pro",
  name: "Weather Pro",
  description: "Forecasts with x402 micro-payments per call",
  category: "Data",
  endpointUrl: "https://api.weather-pro.example.com/mcp",
  priceUsdc: 0.05,
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  tags: ["weather", "forecast"],
  status: "published",
  ...overrides,
});

describe("/registry/tools — REST", () => {
  let db: Db;
  let server: Server;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    server = await startApp(createApp({ db, solana: dummySolana }));
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("rejects publish without API key", async () => {
    const res = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validBody()),
    });
    expect(res.status).toBe(401);
  });

  it("publishes a tool, lists it, and returns it by slug", async () => {
    const merchant = makeMerchant(db, "alice");

    const publish = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify(validBody()),
    });
    expect(publish.status).toBe(201);
    const created = (await publish.json()) as { tool: { slug: string; merchantId: string; status: string } };
    expect(created.tool.slug).toBe("weather-pro");
    expect(created.tool.merchantId).toBe(merchant.id);
    expect(created.tool.status).toBe("published");

    const list = await fetch(`${server.url}/registry/tools`);
    expect(list.status).toBe(200);
    const listed = (await list.json()) as { tools: Array<{ slug: string }> };
    expect(listed.tools.map((t) => t.slug)).toContain("weather-pro");

    const detail = await fetch(`${server.url}/registry/tools/weather-pro`);
    expect(detail.status).toBe(200);
    const fetched = (await detail.json()) as { tool: { name: string } };
    expect(fetched.tool.name).toBe("Weather Pro");
  });

  it("hides draft tools from the public listing", async () => {
    const merchant = makeMerchant(db, "bob");
    const res = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify(validBody({ status: "draft" })),
    });
    expect(res.status).toBe(201);

    const publicList = await fetch(`${server.url}/registry/tools`);
    const publicJson = (await publicList.json()) as { tools: Array<{ slug: string }> };
    expect(publicJson.tools).toHaveLength(0);

    const detail = await fetch(`${server.url}/registry/tools/weather-pro`);
    expect(detail.status).toBe(404);

    const mine = await fetch(`${server.url}/registry/tools/mine`, {
      headers: { "x-zettapay-api-key": merchant.apiKey },
    });
    const mineJson = (await mine.json()) as { tools: Array<{ slug: string }> };
    expect(mineJson.tools.map((t) => t.slug)).toEqual(["weather-pro"]);
  });

  it("rejects http endpoints (must be https)", async () => {
    const merchant = makeMerchant(db, "carol");
    const res = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify(validBody({ endpointUrl: "http://insecure.example.com/mcp" })),
    });
    expect(res.status).toBe(400);
  });

  it("rejects invalid slug format", async () => {
    const merchant = makeMerchant(db, "dave");
    const res = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchant.apiKey,
      },
      body: JSON.stringify(validBody({ slug: "Invalid Slug" })),
    });
    expect(res.status).toBe(400);
  });

  it("conflicts on duplicate slug", async () => {
    const m1 = makeMerchant(db, "eve");
    const m2 = makeMerchant(db, "frank");

    const r1 = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": m1.apiKey,
      },
      body: JSON.stringify(validBody()),
    });
    expect(r1.status).toBe(201);

    const r2 = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": m2.apiKey,
      },
      body: JSON.stringify(validBody()),
    });
    expect(r2.status).toBe(409);
  });

  it("filters by category, query, and maxPriceUsdc", async () => {
    const merchant = makeMerchant(db, "grace");
    const tools = [
      validBody({
        slug: "weather-pro",
        category: "data",
        priceUsdc: 0.01,
        name: "Weather Pro",
      }),
      validBody({
        slug: "image-gen",
        category: "vision",
        priceUsdc: 0.5,
        name: "Image Gen",
      }),
      validBody({
        slug: "translator",
        category: "data",
        priceUsdc: 0.1,
        name: "Translator",
        description: "Translates text via x402",
      }),
    ];
    for (const body of tools) {
      const r = await fetch(`${server.url}/registry/tools`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": merchant.apiKey,
        },
        body: JSON.stringify(body),
      });
      expect(r.status).toBe(201);
    }

    const byCategory = await fetch(
      `${server.url}/registry/tools?category=data`,
    );
    const byCategoryJson = (await byCategory.json()) as {
      tools: Array<{ slug: string }>;
    };
    expect(byCategoryJson.tools.map((t) => t.slug).sort()).toEqual([
      "translator",
      "weather-pro",
    ]);

    const byPrice = await fetch(
      `${server.url}/registry/tools?maxPriceUsdc=0.05`,
    );
    const byPriceJson = (await byPrice.json()) as {
      tools: Array<{ slug: string }>;
    };
    expect(byPriceJson.tools.map((t) => t.slug)).toEqual(["weather-pro"]);

    const byQuery = await fetch(
      `${server.url}/registry/tools?q=translate`,
    );
    const byQueryJson = (await byQuery.json()) as {
      tools: Array<{ slug: string }>;
    };
    expect(byQueryJson.tools.map((t) => t.slug)).toEqual(["translator"]);
  });

  it("only the publisher can patch or delete a tool", async () => {
    const owner = makeMerchant(db, "owner");
    const intruder = makeMerchant(db, "intruder");

    const create = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": owner.apiKey,
      },
      body: JSON.stringify(validBody()),
    });
    expect(create.status).toBe(201);

    const intruderPatch = await fetch(
      `${server.url}/registry/tools/weather-pro`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": intruder.apiKey,
        },
        body: JSON.stringify({ name: "Hijacked" }),
      },
    );
    expect(intruderPatch.status).toBe(404);

    const ownerPatch = await fetch(
      `${server.url}/registry/tools/weather-pro`,
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-zettapay-api-key": owner.apiKey,
        },
        body: JSON.stringify({ priceUsdc: 0.25 }),
      },
    );
    expect(ownerPatch.status).toBe(200);
    const patched = (await ownerPatch.json()) as { tool: { priceUsdc: number } };
    expect(patched.tool.priceUsdc).toBe(0.25);

    const ownerDelete = await fetch(
      `${server.url}/registry/tools/weather-pro`,
      {
        method: "DELETE",
        headers: { "x-zettapay-api-key": owner.apiKey },
      },
    );
    expect(ownerDelete.status).toBe(204);

    const after = await fetch(`${server.url}/registry/tools/weather-pro`);
    expect(after.status).toBe(404);
  });
});

describe("/mcp/marketplace — discovery JSON-RPC", () => {
  let db: Db;
  let server: Server;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    server = await startApp(createApp({ db, solana: dummySolana }));
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  async function publish(merchantApiKey: string, overrides: Record<string, unknown> = {}) {
    const r = await fetch(`${server.url}/registry/tools`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zettapay-api-key": merchantApiKey,
      },
      body: JSON.stringify(validBody(overrides)),
    });
    if (r.status !== 201) {
      throw new Error(`publish failed: ${r.status} ${await r.text()}`);
    }
  }

  async function rpc(method: string, params: Record<string, unknown> = {}) {
    const r = await fetch(`${server.url}/mcp/marketplace`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return r;
  }

  it("GET /mcp/marketplace returns the MCP server descriptor", async () => {
    const r = await fetch(`${server.url}/mcp/marketplace`);
    expect(r.status).toBe(200);
    const json = (await r.json()) as {
      protocolVersion: string;
      tools: Array<{ name: string }>;
    };
    expect(json.protocolVersion).toBe("2024-11-05");
    expect(json.tools.map((t) => t.name).sort()).toEqual([
      "discover_tools",
      "get_tool",
      "install_tool",
    ]);
  });

  it("tools/list and discover_tools return published tools", async () => {
    const merchant = makeMerchant(db, "rpc1");
    await publish(merchant.apiKey, {
      slug: "translator",
      category: "data",
      priceUsdc: 0.1,
      name: "Translator",
    });

    const list = await rpc("tools/list");
    const listJson = (await list.json()) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listJson.result.tools.map((t) => t.name)).toContain("discover_tools");

    const call = await rpc("tools/call", {
      name: "discover_tools",
      arguments: { category: "data" },
    });
    const callJson = (await call.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const payload = JSON.parse(callJson.result.content[0]!.text) as {
      tools: Array<{ slug: string; paymentProtocol: string }>;
    };
    expect(payload.tools.map((t) => t.slug)).toContain("translator");
    expect(payload.tools[0]!.paymentProtocol).toBe("x402");
  });

  it("get_tool returns 404-shape error for unknown slug", async () => {
    const r = await rpc("tools/call", {
      name: "get_tool",
      arguments: { slug: "does-not-exist" },
    });
    const json = (await r.json()) as {
      result: { isError: boolean; content: Array<{ text: string }> };
    };
    expect(json.result.isError).toBe(true);
    const err = JSON.parse(json.result.content[0]!.text) as {
      error: { code: string };
    };
    expect(err.error.code).toBe("not_found");
  });

  it("install_tool increments install_count", async () => {
    const merchant = makeMerchant(db, "rpc2");
    await publish(merchant.apiKey);

    const r1 = await rpc("tools/call", {
      name: "install_tool",
      arguments: { slug: "weather-pro" },
    });
    const j1 = (await r1.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const t1 = JSON.parse(j1.result.content[0]!.text) as {
      tool: { installCount: number };
    };
    expect(t1.tool.installCount).toBe(1);

    const r2 = await rpc("tools/call", {
      name: "install_tool",
      arguments: { slug: "weather-pro" },
    });
    const j2 = (await r2.json()) as {
      result: { content: Array<{ text: string }> };
    };
    const t2 = JSON.parse(j2.result.content[0]!.text) as {
      tool: { installCount: number };
    };
    expect(t2.tool.installCount).toBe(2);
  });
});
