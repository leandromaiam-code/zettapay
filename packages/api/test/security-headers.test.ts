import { describe, expect, it } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { securityHeaders } from "../src/middleware/security-headers.js";

function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
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

function fetchHead(url: string): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, resolve);
    req.on("error", reject);
  });
}

describe("securityHeaders", () => {
  it("sets baseline headers on every response", async () => {
    const app = express();
    app.use(securityHeaders({ enableHsts: false }));
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const srv = await listen(app);
    try {
      const res = await fetchHead(`${srv.url}/x`);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("no-referrer");
      expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
      expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
      expect(res.headers["permissions-policy"]).toContain("geolocation=()");
      expect(res.headers["strict-transport-security"]).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("emits HSTS when enabled", async () => {
    const app = express();
    app.use(securityHeaders({ enableHsts: true }));
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const srv = await listen(app);
    try {
      const res = await fetchHead(`${srv.url}/x`);
      expect(res.headers["strict-transport-security"]).toContain("max-age=63072000");
      expect(res.headers["strict-transport-security"]).toContain("includeSubDomains");
    } finally {
      await srv.close();
    }
  });

  it("respects custom CSP override", async () => {
    const app = express();
    app.use(
      securityHeaders({
        enableHsts: false,
        contentSecurityPolicy: "default-src 'self'",
      }),
    );
    app.get("/x", (_req, res) => res.json({ ok: true }));
    const srv = await listen(app);
    try {
      const res = await fetchHead(`${srv.url}/x`);
      expect(res.headers["content-security-policy"]).toBe("default-src 'self'");
    } finally {
      await srv.close();
    }
  });
});
