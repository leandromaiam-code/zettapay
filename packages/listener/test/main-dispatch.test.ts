// Regression coverage for the Z64 dispatcher fix. The bugs we're locking down:
//   1. `zettapay-listener --help` / `--version` / `help` returned exit 0 with
//      empty stdout because they fell through to the `start` branch.
//   2. Subcommand promises were not awaited consistently; this test exercises
//      the dispatch path end-to-end through an in-process call (no subprocess)
//      so we can assert each subcommand's stdout actually flushed.
//   3. Unknown subcommands now exit 2 and print the top-level help banner.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatch, packageVersion } from '../src/main.js';

let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let captured = '';
let capturedErr = '';
beforeEach(() => {
  captured = '';
  capturedErr = '';
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    captured += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  });
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
    capturedErr += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  });
});
afterEach(() => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
});

describe('main dispatch — Z64 regressions', () => {
  it('--help prints the banner with all 7 subcommands', async () => {
    const code = await dispatch(['--help']);
    expect(code).toBe(0);
    for (const sub of [
      'init',
      'start',
      'healthcheck',
      'verify-config',
      'migrate',
      'derive-address',
      'create-invoice',
    ]) {
      expect(captured).toContain(sub);
    }
  });

  it('-h is an alias for --help', async () => {
    const code = await dispatch(['-h']);
    expect(code).toBe(0);
    expect(captured).toContain('zettapay-listener');
  });

  it('help (bare verb) is an alias for --help', async () => {
    const code = await dispatch(['help']);
    expect(code).toBe(0);
    expect(captured).toContain('zettapay-listener');
  });

  it('--version prints the installed version', async () => {
    const code = await dispatch(['--version']);
    expect(code).toBe(0);
    expect(captured).toMatch(/^zettapay-listener \d+\.\d+\.\d+\n$/);
  });

  it('-v is an alias for --version', async () => {
    const code = await dispatch(['-v']);
    expect(code).toBe(0);
    expect(captured).toMatch(/^zettapay-listener \d+\.\d+\.\d+\n$/);
  });

  it('packageVersion is at least 0.1.1', async () => {
    const v = packageVersion();
    const [maj, min, patch] = v.split('.').map((n) => Number.parseInt(n, 10));
    expect(maj).toBeGreaterThanOrEqual(0);
    expect(min).toBeGreaterThanOrEqual(1);
    expect((maj as number) > 0 || (min as number) > 1 || (patch as number) >= 1).toBe(true);
  });

  it('unknown subcommand exits 2 and prints the banner on stderr', async () => {
    const code = await dispatch(['frobnicate']);
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/unknown command "frobnicate"/);
    expect(capturedErr).toContain('init');
  });

  it('routes start --help to the start usage banner (no env required)', async () => {
    const code = await dispatch(['start', '--help']);
    expect(code).toBe(0);
    expect(captured).toMatch(/zettapay-listener start/);
    expect(captured).toMatch(/--health-port/);
  });

  it('routes derive-address --help through (regression: previously exit 0 empty)', async () => {
    const code = await dispatch(['derive-address', '--help']);
    expect(code).toBe(0);
    expect(captured).toMatch(/derive-address/);
  });

  it('routes create-invoice --help through', async () => {
    const code = await dispatch(['create-invoice', '--help']);
    expect(code).toBe(0);
    expect(captured).toMatch(/create-invoice/);
  });
});
