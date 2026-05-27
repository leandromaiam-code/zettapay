import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runInit } from '../src/cli/init.js';
import { parseEnv } from '../src/cli/util.js';
import type { Prompter } from '../src/cli/util.js';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-init-'));
  tmpdirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpdirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const VALID_ZPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';

class NoopPrompter implements Prompter {
  async ask(): Promise<string> {
    throw new Error('unexpected prompt — non-interactive path expected');
  }
  async confirm(): Promise<boolean> {
    throw new Error('unexpected confirm — non-interactive path expected');
  }
  close(): void {}
}

describe('runInit (flag-driven, non-interactive)', () => {
  it('writes .env + seeds merchant.json with json storage', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    const code = await runInit(
      [
        '--xpub', VALID_ZPUB,
        '--shop-name', 'Acme',
        '--email', 'op@acme.test',
        '--webhook-url', 'https://acme.test/zp/hook',
        '--storage', 'json',
        '--data-dir', dataDir,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(0);

    const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
    expect(env.STORAGE).toBe('json');
    expect(env.MERCHANT_XPUB).toBe(VALID_ZPUB);
    expect(env.MERCHANT_WEBHOOK_URL).toBe('https://acme.test/zp/hook');
    expect(env.MERCHANT_WEBHOOK_SECRET?.startsWith('whsec_')).toBe(true);
    expect(env.MERCHANT_ID?.length).toBeGreaterThan(10);
    expect(env.ZETTAPAY_DATA_DIR).toBe(dataDir);

    const merchant = JSON.parse(
      await fs.readFile(path.join(dataDir, 'merchant.json'), 'utf8'),
    );
    expect(merchant.shop_name).toBe('Acme');
    expect(merchant.xpub).toBe(VALID_ZPUB);
    expect(merchant.next_child_index).toBe(0);
    expect(typeof merchant.webhook_secret_hash).toBe('string');
    expect(merchant.webhook_secret_hash.length).toBe(64);
    // raw secret MUST NOT be persisted on disk
    expect(merchant.webhook_secret_hash).not.toBe(env.MERCHANT_WEBHOOK_SECRET);
  });

  it('exits 2 when xpub is xprv (HR-CUSTODY)', async () => {
    const cwd = await makeTmpDir();
    const code = await runInit(
      [
        '--xpub', 'xprv' + VALID_ZPUB.slice(4),
        '--shop-name', 'X',
        '--email', 'x@x.test',
        '--webhook-url', 'https://x.test/h',
        '--storage', 'json',
        '--data-dir', cwd,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(2);
    // No .env should have been written
    await expect(fs.access(path.join(cwd, '.env'))).rejects.toBeTruthy();
  });

  it('exits 2 when webhook URL is plain http on a public host', async () => {
    const cwd = await makeTmpDir();
    const code = await runInit(
      [
        '--xpub', VALID_ZPUB,
        '--shop-name', 'X',
        '--email', 'x@x.test',
        '--webhook-url', 'http://insecure.test/h',
        '--storage', 'json',
        '--data-dir', cwd,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(2);
  });

  it('accepts http://127.0.0.1 webhook URL (localhost-http dev carve-out)', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    const code = await runInit(
      [
        '--xpub', VALID_ZPUB,
        '--shop-name', 'Acme',
        '--email', 'op@acme.test',
        '--webhook-url', 'http://127.0.0.1:9876/webhook',
        '--storage', 'json',
        '--data-dir', dataDir,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(0);
    const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
    expect(env.MERCHANT_WEBHOOK_URL).toBe('http://127.0.0.1:9876/webhook');
  });

  it('accepts http://localhost webhook URL (localhost-http dev carve-out)', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    const code = await runInit(
      [
        '--xpub', VALID_ZPUB,
        '--shop-name', 'Acme',
        '--email', 'op@acme.test',
        '--webhook-url', 'http://localhost:3000/zp/hook',
        '--storage', 'json',
        '--data-dir', dataDir,
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(0);
    const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
    expect(env.MERCHANT_WEBHOOK_URL).toBe('http://localhost:3000/zp/hook');
  });

  it('--force overwrites an existing .env', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(cwd, '.env'), 'STALE=1\n');
    const code = await runInit(
      [
        '--xpub', VALID_ZPUB,
        '--shop-name', 'X',
        '--email', 'x@x.test',
        '--webhook-url', 'https://x.test/h',
        '--storage', 'json',
        '--data-dir', dataDir,
        '--force',
      ],
      { cwd, prompter: new NoopPrompter() },
    );
    expect(code).toBe(0);
    const env = parseEnv(await fs.readFile(path.join(cwd, '.env'), 'utf8'));
    expect(env.STALE).toBeUndefined();
    expect(env.MERCHANT_XPUB).toBe(VALID_ZPUB);
  });
});
