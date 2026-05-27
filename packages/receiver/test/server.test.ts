import { describe, expect, it } from 'vitest';
import { ReceiverServer, signRequest } from '../src/server.js';
import type { ReceiverLogger } from '../src/server.js';

const SECRET = 'whsec_server_unit';

function silentLogger(): ReceiverLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

describe('ReceiverServer.handleRaw', () => {
  it('returns service status on GET /', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const { status, body } = await server.handleRaw('GET', '/', {}, Buffer.alloc(0));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: 'zettapay-receiver',
    });
  });

  it('returns 404 for unknown paths', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const { status, body } = await server.handleRaw('POST', '/elsewhere', {}, Buffer.alloc(0));
    expect(status).toBe(404);
    expect(body).toMatchObject({ ok: false, error: 'not_found' });
  });

  it('accepts a correctly-signed POST /webhook', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const body = Buffer.from('{"event":"invoice.confirmed","invoice_id":"inv_1"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(SECRET, body);
    const { status, body: resp, outcome } = await server.handleRaw(
      'POST',
      '/webhook',
      { 'x-zettapay-signature': sig, 'x-zettapay-timestamp': ts },
      body,
    );
    expect(status).toBe(200);
    expect(resp).toMatchObject({ ok: true });
    expect(outcome?.ok).toBe(true);
    expect(server.stats.requestsOk).toBe(1);
    expect(server.stats.requestsTotal).toBe(1);
  });

  it('returns 401 on signature mismatch', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const body = Buffer.from('{"event":"x"}');
    const ts = String(Math.floor(Date.now() / 1000));
    const { status, body: resp, outcome } = await server.handleRaw(
      'POST',
      '/webhook',
      { 'x-zettapay-signature': 'deadbeef'.repeat(8), 'x-zettapay-timestamp': ts },
      body,
    );
    expect(status).toBe(401);
    expect(resp).toMatchObject({ ok: false, error: 'invalid_signature' });
    expect(outcome?.ok).toBe(false);
    expect(server.stats.requestsFailed).toBe(1);
  });

  it('returns 401 on stale timestamp', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const body = Buffer.from('{"event":"x"}');
    const ts = String(Math.floor(Date.now() / 1000) - 3600); // 1h ago
    const sig = signRequest(SECRET, body);
    const { status, body: resp } = await server.handleRaw(
      'POST',
      '/webhook',
      { 'x-zettapay-signature': sig, 'x-zettapay-timestamp': ts },
      body,
    );
    expect(status).toBe(401);
    expect(resp).toMatchObject({ ok: false, error: 'timestamp_too_old' });
  });

  it('returns 400 on missing headers', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const { status, body: resp } = await server.handleRaw(
      'POST',
      '/webhook',
      {},
      Buffer.from('{}'),
    );
    expect(status).toBe(400);
    expect(resp).toMatchObject({ ok: false, error: 'missing_signature' });
  });

  it('returns 400 on malformed JSON body even with valid signature', async () => {
    const server = new ReceiverServer({ secret: SECRET, port: 0, log: silentLogger() });
    const body = Buffer.from('not json {{{');
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signRequest(SECRET, body);
    const { status, body: resp } = await server.handleRaw(
      'POST',
      '/webhook',
      { 'x-zettapay-signature': sig, 'x-zettapay-timestamp': ts },
      body,
    );
    expect(status).toBe(400);
    expect(resp).toMatchObject({ ok: false, error: 'malformed_body' });
  });
});
