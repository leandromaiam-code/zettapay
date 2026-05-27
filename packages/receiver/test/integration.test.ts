// Integration: bind a real socket, POST over HTTP, assert the receiver's
// stats + response. This is the test that catches `node:http` integration
// regressions that handleRaw wouldn't (header casing, body streaming,
// content-length, etc.).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReceiverServer, signRequest } from '../src/server.js';

const SECRET = 'whsec_integration_test';

let server: ReceiverServer;
let url: string;

beforeEach(async () => {
  server = new ReceiverServer({
    secret: SECRET,
    bind: '127.0.0.1',
    port: 0, // ephemeral
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const bound = await server.listen();
  url = `http://${bound.host}:${bound.port}`;
});

afterEach(async () => {
  await server.close();
});

describe('integration', () => {
  it('POST /webhook with valid signature → 200', async () => {
    const body = JSON.stringify({ event: 'invoice.confirmed', invoice_id: 'inv_42' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(SECRET, body);
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zettapay-signature': sig,
        'x-zettapay-timestamp': ts,
      },
      body,
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);
    expect(server.stats.requestsOk).toBe(1);
  });

  it('POST /webhook with bad signature → 401', async () => {
    const body = JSON.stringify({ event: 'x' });
    const ts = String(Math.floor(Date.now() / 1000));
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-zettapay-signature': '0'.repeat(64),
        'x-zettapay-timestamp': ts,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid_signature');
    expect(server.stats.requestsFailed).toBe(1);
  });

  it('GET / returns service status with counters', async () => {
    const res = await fetch(`${url}/`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.service).toBe('zettapay-receiver');
    expect(typeof json.uptime_s).toBe('number');
    expect(json.requests_total).toBe(0);
  });

  it('exposes only / and POST /webhook (everything else 404)', async () => {
    const res = await fetch(`${url}/admin`);
    expect(res.status).toBe(404);
  });

  it('invokes onWebhook hook on every request (ok + failed)', async () => {
    const outcomes: Array<{ ok: boolean; reason?: string }> = [];
    const localServer = new ReceiverServer({
      secret: SECRET,
      bind: '127.0.0.1',
      port: 0,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      onWebhook: (o) => outcomes.push({ ok: o.ok, reason: o.reason }),
    });
    const bound = await localServer.listen();
    const u = `http://${bound.host}:${bound.port}`;
    try {
      // Bad signature
      await fetch(`${u}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-zettapay-signature': '0'.repeat(64),
          'x-zettapay-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body: '{}',
      });
      // Good signature
      const body = '{"event":"x"}';
      await fetch(`${u}/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-zettapay-signature': signRequest(SECRET, body),
          'x-zettapay-timestamp': String(Math.floor(Date.now() / 1000)),
        },
        body,
      });
      expect(outcomes).toHaveLength(2);
      expect(outcomes[0]).toMatchObject({ ok: false, reason: 'invalid_signature' });
      expect(outcomes[1]).toMatchObject({ ok: true });
    } finally {
      await localServer.close();
    }
  });
});
