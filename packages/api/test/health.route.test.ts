import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { healthRouter, buildPrometheusMetrics } from "../src/routes/health.js";

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

interface FakeRpc {
  url: string;
  close: () => Promise<void>;
}

function startFakeRpc(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<FakeRpc> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
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

function buildHealthApp(): express.Express {
  const app = express();
  app.use(healthRouter());
  return app;
}

describe("health router", () => {
  let server: RunningServer;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    server = await startApp(buildHealthApp());
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await server.close();
  });

  it("GET /health returns 200 with liveness payload", async () => {
    const response = await fetch(`${server.url}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.service).toBe("zettapay-api");
    expect(typeof body.uptimeSec).toBe("number");
    expect(typeof body.timestamp).toBe("string");
  });

  it("GET /ready returns 503 when SOLANA_RPC_URL is not configured", async () => {
    delete process.env.SOLANA_RPC_URL;
    const response = await fetch(`${server.url}/ready`);
    expect(response.status).toBe(503);
    const body = (await response.json()) as Record<string, any>;
    expect(body.status).toBe("unready");
    expect(body.checks.solanaRpc.ok).toBe(false);
    expect(body.checks.solanaRpc.detail).toBe("not_configured");
  });

  it("GET /ready returns 200 when Solana RPC reports ok", async () => {
    const rpc = await startFakeRpc((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "ok" }));
    });
    process.env.SOLANA_RPC_URL = rpc.url;
    try {
      const response = await fetch(`${server.url}/ready`);
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, any>;
      expect(body.status).toBe("ready");
      expect(body.checks.solanaRpc.ok).toBe(true);
    } finally {
      await rpc.close();
    }
  });

  it("GET /ready returns 503 when Solana RPC returns rpc error", async () => {
    const rpc = await startFakeRpc((_req, res) => {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom" } }));
    });
    process.env.SOLANA_RPC_URL = rpc.url;
    try {
      const response = await fetch(`${server.url}/ready`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, any>;
      expect(body.status).toBe("unready");
      expect(body.checks.solanaRpc.ok).toBe(false);
      expect(body.checks.solanaRpc.detail).toBe("boom");
    } finally {
      await rpc.close();
    }
  });

  it("GET /ready returns 503 when Solana RPC returns non-2xx", async () => {
    const rpc = await startFakeRpc((_req, res) => {
      res.statusCode = 502;
      res.end();
    });
    process.env.SOLANA_RPC_URL = rpc.url;
    try {
      const response = await fetch(`${server.url}/ready`);
      expect(response.status).toBe(503);
      const body = (await response.json()) as Record<string, any>;
      expect(body.status).toBe("unready");
      expect(body.checks.solanaRpc.ok).toBe(false);
      expect(body.checks.solanaRpc.detail).toBe("http_502");
    } finally {
      await rpc.close();
    }
  });

  it("GET /metrics returns Prometheus text exposition", async () => {
    const response = await fetch(`${server.url}/metrics`);
    expect(response.status).toBe(200);
    const contentType = response.headers.get("content-type") ?? "";
    expect(contentType).toContain("text/plain");
    expect(contentType).toContain("version=0.0.4");
    const body = await response.text();
    expect(body).toContain("# HELP zettapay_build_info");
    expect(body).toContain("# TYPE zettapay_build_info gauge");
    expect(body).toContain("zettapay_build_info{");
    expect(body).toContain("# HELP process_uptime_seconds");
    expect(body).toContain("# TYPE process_resident_memory_bytes gauge");
    expect(body).toContain("# TYPE process_cpu_user_seconds_total counter");
  });
});

describe("buildPrometheusMetrics", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("emits configured=1 when env vars are set", () => {
    process.env.SOLANA_RPC_URL = "https://rpc.example.test";
    process.env.MOONPAY_WEBHOOK_SECRET = "abc";
    process.env.MERCHANT_WEBHOOK_URL = "https://merchant.example.test/hook";
    const text = buildPrometheusMetrics();
    expect(text).toMatch(/zettapay_solana_rpc_configured 1/);
    expect(text).toMatch(/zettapay_moonpay_webhook_configured 1/);
    expect(text).toMatch(/zettapay_merchant_webhook_configured 1/);
  });

  it("emits configured=0 when env vars are missing", () => {
    delete process.env.SOLANA_RPC_URL;
    delete process.env.MOONPAY_WEBHOOK_SECRET;
    delete process.env.MERCHANT_WEBHOOK_URL;
    const text = buildPrometheusMetrics();
    expect(text).toMatch(/zettapay_solana_rpc_configured 0/);
    expect(text).toMatch(/zettapay_moonpay_webhook_configured 0/);
    expect(text).toMatch(/zettapay_merchant_webhook_configured 0/);
  });

  it("escapes label values containing special characters", () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc"def';
    const text = buildPrometheusMetrics();
    expect(text).toContain('version="abc\\"def"');
  });
});
