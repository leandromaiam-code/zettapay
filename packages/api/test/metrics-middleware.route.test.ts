import { afterEach, beforeEach, describe, expect, it } from "vitest";
import express, { Router, type Express } from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { metricsMiddleware } from "../src/middleware/metrics.js";
import {
  httpRequestDurationSeconds,
  httpRequestsTotal,
  registry,
} from "../src/lib/metrics.js";

interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

function start(app: Express): Promise<RunningServer> {
  return new Promise((resolve) => {
    const server = http.createServer(app);
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

describe("metricsMiddleware", () => {
  let server: RunningServer;

  beforeEach(() => {
    httpRequestsTotal.reset();
    httpRequestDurationSeconds.reset();
  });

  afterEach(async () => {
    await server.close();
    registry.resetForTest();
  });

  it("records counter + histogram per request and labels by route template", async () => {
    const app = express();
    app.use(metricsMiddleware());

    const r = Router();
    r.get("/payments/:id", (_req, res) => res.json({ ok: true }));
    r.post("/payments", (_req, res) => res.status(201).json({ ok: true }));
    r.get("/boom", (_req, _res, next) => next(new Error("boom")));
    app.use(r);
    app.use(((err, _req, res, _next) => {
      res.status(500).json({ error: err.message });
    }) as express.ErrorRequestHandler);

    server = await start(app);

    await fetch(`${server.url}/payments/abc`);
    await fetch(`${server.url}/payments/def`);
    await fetch(`${server.url}/payments`, { method: "POST" });
    await fetch(`${server.url}/boom`);

    const text = registry.render();

    // Path-template aggregation: both /payments/abc and /payments/def collapse
    // to /payments/:id so cardinality stays bounded.
    expect(text).toContain(
      'zettapay_http_requests_total{method="GET",route="/payments/:id",status="200",status_class="2xx"} 2',
    );
    expect(text).toContain(
      'zettapay_http_requests_total{method="POST",route="/payments",status="201",status_class="2xx"} 1',
    );
    expect(text).toContain(
      'zettapay_http_requests_total{method="GET",route="/boom",status="500",status_class="5xx"} 1',
    );
    expect(text).toMatch(/zettapay_http_request_duration_seconds_count\{[^}]*route="\/payments\/:id"[^}]*\} 2/);
  });

  it("collapses unmatched routes under a single 'unmatched' label", async () => {
    const app = express();
    app.use(metricsMiddleware());
    app.use((_req, res) => res.status(404).json({ error: "not_found" }));
    server = await start(app);

    await fetch(`${server.url}/does-not-exist-1`);
    await fetch(`${server.url}/does-not-exist-2`);

    const text = registry.render();
    expect(text).toContain(
      'zettapay_http_requests_total{method="GET",route="unmatched",status="404",status_class="4xx"} 2',
    );
  });

  it("does not record a sample for the /metrics endpoint itself", async () => {
    const app = express();
    app.use(metricsMiddleware());
    app.get("/metrics", (_req, res) => res.type("text/plain").send("ok"));
    app.get("/other", (_req, res) => res.json({ ok: true }));
    server = await start(app);

    await fetch(`${server.url}/metrics`);
    await fetch(`${server.url}/other`);

    const text = registry.render();
    expect(text).not.toMatch(/route="\/metrics"/);
    expect(text).toContain('route="/other"');
  });
});
