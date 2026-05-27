import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/cli/init.js';
import { runDeriveAddress } from '../src/cli/derive-address.js';
import { parseEnv } from '../src/cli/util.js';

const VALID_ZPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-derive-'));
  tmpdirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpdirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

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

class NoopPrompter {
  async ask(): Promise<string> {
    throw new Error('unexpected prompt');
  }
  async confirm(): Promise<boolean> {
    throw new Error('unexpected confirm');
  }
  close(): void {}
}

async function seed(): Promise<{ env: Record<string, string>; dataDir: string }> {
  const cwd = await makeTmpDir();
  const dataDir = await makeTmpDir();
  await runInit(
    [
      '--xpub', VALID_ZPUB,
      '--shop-name', 'Acme',
      '--email', 'op@acme.test',
      '--webhook-url', 'https://acme.test/h',
      '--storage', 'json',
      '--data-dir', dataDir,
    ],
    { cwd, prompter: new NoopPrompter() },
  );
  const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
  return { env, dataDir };
}

describe('runDeriveAddress', () => {
  it('derives the m/0/0 bech32 address from MERCHANT_XPUB', async () => {
    const { env } = await seed();
    const code = await runDeriveAddress([], { env });
    expect(code).toBe(0);
    expect(captured).toMatch(/address:\s+bc1[a-z0-9]+/i);
    expect(captured).toMatch(/path:\s+m\/0\/0/);
    expect(captured).toMatch(/network:\s+mainnet/);
  });

  it('honours --index for arbitrary child positions', async () => {
    const { env } = await seed();
    const code = await runDeriveAddress(['--index', '7'], { env });
    expect(code).toBe(0);
    expect(captured).toMatch(/path:\s+m\/0\/7/);
  });

  it('refuses an extended PRIVATE key passed via --xpub (HR-CUSTODY)', async () => {
    const { env } = await seed();
    const code = await runDeriveAddress(
      ['--xpub', 'xprv' + VALID_ZPUB.slice(4)],
      { env },
    );
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/xprv|PRIVATE/i);
  });

  it('exits 2 when MERCHANT_XPUB is absent and no flag override', async () => {
    const code = await runDeriveAddress([], { env: {} });
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/MERCHANT_XPUB/);
  });

  it('rejects negative --index', async () => {
    const { env } = await seed();
    const code = await runDeriveAddress(['--index', '-1'], { env });
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/index/);
  });

  it('--help prints usage and exits 0', async () => {
    const code = await runDeriveAddress(['--help'], { env: {} });
    expect(code).toBe(0);
    expect(captured).toMatch(/derive-address/);
  });
});
