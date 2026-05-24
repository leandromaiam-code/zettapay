import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHealthcheck } from '../src/cli/healthcheck.js';

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runHealthcheck', () => {
  it('returns 0 when server reports ok=true', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          ws_connected: true,
          subscribed_count: 3,
          last_event_at: null,
          last_block_height: 850000,
          uptime_s: 42,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const code = await runHealthcheck(['--port', '9999'], {
      env: {},
      cwd: '/nonexistent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns 1 when server reports ok=false', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, ws_connected: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const code = await runHealthcheck(['--port', '9999'], {
      env: {},
      cwd: '/nonexistent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(1);
  });

  it('returns 1 when server unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const code = await runHealthcheck(['--port', '9999'], {
      env: {},
      cwd: '/nonexistent',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(code).toBe(1);
  });
});
