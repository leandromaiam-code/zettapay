// Z47 — /pay/evm is retired. Every request should land on 410 Gone with
// the canonical sunset payload pointing operators at the new HD-derived
// invoice flow (`POST /admin/invoices` + on-chain listener).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import type { AddressInfo } from "node:net";
import { payEvmRouter } from "../src/routes/pay_evm.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function startApp(app: Express): Promise<RunningServer> {
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

describe("POST /pay/evm — retired in Z47", () => {
  let server: RunningServer;

  beforeEach(async () => {
    const app = express();
    app.use(express.json());
    app.use(payEvmRouter());
    server = await startApp(app);
  });

  afterEach(async () => {
    if (server) await server.close();
  });

  it("returns 410 Gone for /pay/evm/:merchantRef", async () => {
    const res = await fetch(`${server.url}/pay/evm/@acme`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chain: "base", amount: 1 }),
    });
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("gone");
    expect(body.error.message).toMatch(/retired/);
    expect(body.error.message).toMatch(/POST \/admin\/invoices/);
  });

  it("returns 410 Gone for the legacy bare /pay/evm path too", async () => {
    const res = await fetch(`${server.url}/pay/evm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(410);
  });
});
