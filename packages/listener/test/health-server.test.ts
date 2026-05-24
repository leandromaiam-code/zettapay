import { afterEach, describe, expect, it } from 'vitest';
import { HealthServer } from '../src/health-server.js';
import type { ListenerStatus } from '../src/listener.js';

const servers: HealthServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

function pickPort(): number {
  // Random high port in a range unlikely to collide in CI
  return 18000 + Math.floor(Math.random() * 1000);
}

describe('HealthServer', () => {
  it('GET /health returns 200 with snapshot shape', async () => {
    const snapshot: ListenerStatus = {
      wsConnected: true,
      subscribedCount: 3,
      lastEventAt: 1_700_000_000_000,
      lastBlockHeight: 850_123,
      uptimeSeconds: 42,
    };
    const port = pickPort();
    const server = new HealthServer({
      port,
      host: '127.0.0.1',
      statusProvider: () => snapshot,
    });
    servers.push(server);
    await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      ok: true,
      ws_connected: true,
      subscribed_count: 3,
      last_event_at: 1_700_000_000_000,
      last_block_height: 850_123,
      uptime_s: 42,
    });
  });

  it('non-GET methods return 405', async () => {
    const port = pickPort();
    const server = new HealthServer({
      port,
      host: '127.0.0.1',
      statusProvider: () => ({
        wsConnected: false,
        subscribedCount: 0,
        lastEventAt: null,
        lastBlockHeight: null,
        uptimeSeconds: 0,
      }),
    });
    servers.push(server);
    await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/health`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
