import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import { type Database as Db } from "better-sqlite3";
import { Keypair } from "@solana/web3.js";
import { createApp } from "../src/app.js";
import { closeDatabase, openDatabase } from "../src/db/index.js";
import {
  getOpenApi30Document,
  getOpenApiDocument,
} from "../src/lib/openapi.js";
import type { SolanaService } from "../src/services/solana.js";

const dummySolana = {
  getPayerPublicKey: () => Keypair.generate().publicKey,
  getUsdcMintAddress: () => "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  transferUsdc: async () => {
    throw new Error("not used in api-docs tests");
  },
} as unknown as SolanaService;

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

describe("GET /openapi.json", () => {
  let db: Db;
  let server: RunningServer;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = await new Promise<RunningServer>((resolve) => {
      const s = app.listen(0, () => {
        const { port } = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((r) => {
              s.close(() => r());
            }),
        });
      });
    });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("serves an OpenAPI 3.1 document with the canonical paths and schemas", async () => {
    const res = await fetch(`${server.url}/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const doc = (await res.json()) as Record<string, any>;
    expect(doc.openapi).toMatch(/^3\.1/);
    expect(doc.info.title).toBe("ZettaPay API");
    expect(typeof doc.info.version).toBe("string");

    const expectedPaths = [
      "/",
      "/healthz",
      "/merchants/register",
      "/merchants/{id}/velocity",
      "/pay",
      "/subscriptions",
      "/subscriptions/{id}",
      "/subscriptions/{id}/cancel",
      "/analytics",
      "/verify-signature",
      "/verify-signature/info",
    ];
    for (const path of expectedPaths) {
      expect(doc.paths[path], `path ${path} should be documented`).toBeDefined();
    }

    expect(doc.components.schemas.Merchant).toBeDefined();
    expect(doc.components.schemas.Payment).toBeDefined();
    expect(doc.components.schemas.Subscription).toBeDefined();
    expect(doc.components.securitySchemes.ApiKeyAuth.name).toBe(
      "x-zettapay-api-key",
    );
    expect(doc.components.securitySchemes.X402Payment.name).toBe(
      "x-402-payment",
    );
  });

  it("derives the server URL from x-forwarded-* headers", async () => {
    const res = await fetch(`${server.url}/openapi.json`, {
      headers: {
        "x-forwarded-proto": "https",
        "x-forwarded-host": "api.zettapay.io",
      },
    });
    const doc = (await res.json()) as Record<string, any>;
    expect(doc.servers[0].url).toBe("https://api.zettapay.io");
  });

  it("references documented schemas only by valid $refs", async () => {
    const res = await fetch(`${server.url}/openapi.json`);
    const doc = (await res.json()) as Record<string, any>;
    const known = new Set(Object.keys(doc.components.schemas));

    const seen: string[] = [];
    function walk(node: unknown): void {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const obj = node as Record<string, unknown>;
      const ref = obj.$ref;
      if (typeof ref === "string") seen.push(ref);
      for (const key of Object.keys(obj)) walk(obj[key]);
    }
    walk(doc.paths);

    expect(seen.length).toBeGreaterThan(0);
    for (const ref of seen) {
      expect(ref.startsWith("#/components/schemas/")).toBe(true);
      const name = ref.slice("#/components/schemas/".length);
      expect(known.has(name), `${name} must exist in components.schemas`).toBe(
        true,
      );
    }
  });
});

describe("GET /docs", () => {
  let db: Db;
  let server: RunningServer;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = await new Promise<RunningServer>((resolve) => {
      const s = app.listen(0, () => {
        const { port } = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((r) => {
              s.close(() => r());
            }),
        });
      });
    });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("renders an HTML page that bootstraps Swagger UI from the OpenAPI spec", async () => {
    const res = await fetch(`${server.url}/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain("<!doctype html>");
    expect(html).toContain('id="swagger-ui"');
    expect(html).toContain("swagger-ui.css");
    expect(html).toContain("swagger-ui-bundle.js");
    expect(html).toContain('"/openapi.json"');
    expect(html).toContain("ZettaPay API reference");
  });
});

describe("GET /openapi-3.0.json", () => {
  let db: Db;
  let server: RunningServer;

  beforeEach(async () => {
    closeDatabase();
    db = openDatabase(":memory:");
    const app = createApp({ db, solana: dummySolana });
    server = await new Promise<RunningServer>((resolve) => {
      const s = app.listen(0, () => {
        const { port } = s.address() as AddressInfo;
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () =>
            new Promise<void>((r) => {
              s.close(() => r());
            }),
        });
      });
    });
  });

  afterEach(async () => {
    await server.close();
    closeDatabase();
  });

  it("serves a 3.0.x document compatible with openapi-generator templates", async () => {
    const res = await fetch(`${server.url}/openapi-3.0.json`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, any>;
    expect(doc.openapi).toMatch(/^3\.0/);
    expect(doc.info.title).toBe("ZettaPay API");
    // 3.0 forbids `info.summary`; downconverter folds it into description.
    expect(doc.info.summary).toBeUndefined();
    expect(typeof doc.info.description).toBe("string");

    // Nullable fields should be expressed as `nullable: true`, never as a
    // `type: [...,"null"]` array.
    function walk(node: unknown): void {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.type)) {
        throw new Error(
          `Found tuple type after downconvert: ${JSON.stringify(obj.type)}`,
        );
      }
      for (const k of Object.keys(obj)) walk(obj[k]);
    }
    walk(doc);

    // Numeric exclusiveMinimum (a 3.1-only encoding) becomes the boolean
    // form alongside `minimum` for 3.0 consumers.
    const amount =
      doc.components.schemas.CreatePaymentRequest.properties.amount;
    expect(amount.minimum).toBe(0);
    expect(amount.exclusiveMinimum).toBe(true);
  });
});

describe("getOpenApiDocument", () => {
  it("caches the document when no serverUrl override is supplied", () => {
    const a = getOpenApiDocument();
    const b = getOpenApiDocument();
    expect(a).toBe(b);
  });

  it("returns a fresh document when serverUrl is provided", () => {
    const a = getOpenApiDocument();
    const b = getOpenApiDocument({ serverUrl: "https://example.test" });
    expect(a).not.toBe(b);
    const servers = (b as Record<string, any>).servers as Array<{
      url: string;
    }>;
    expect(servers[0].url).toBe("https://example.test");
  });
});

describe("getOpenApi30Document", () => {
  it("caches the 3.0 document when no serverUrl override is supplied", () => {
    const a = getOpenApi30Document();
    const b = getOpenApi30Document();
    expect(a).toBe(b);
    expect((a as Record<string, any>).openapi).toMatch(/^3\.0/);
  });

  it("does not mutate the cached 3.1 document", () => {
    const v31 = getOpenApiDocument();
    void getOpenApi30Document();
    expect((v31 as Record<string, any>).openapi).toMatch(/^3\.1/);
  });
});
