import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runVerifyConfig } from '../src/cli/verify-config.js';
import { writeEnvFile } from '../src/cli/util.js';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-verify-'));
  tmpdirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tmpdirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

const VALID_ZPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

describe('runVerifyConfig', () => {
  it('passes with a complete json config', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(dataDir, 'merchant.json'), '{"id":"m_test"}');
    await writeEnvFile(path.join(cwd, '.env'), {
      MERCHANT_XPUB: VALID_ZPUB,
      MERCHANT_WEBHOOK_URL: 'https://acme.test/hook',
      MERCHANT_WEBHOOK_SECRET: 'whsec_aaaaaaaaaaaaaaaaaa',
      HEALTH_PORT: '8787',
      STORAGE: 'json',
      ZETTAPAY_DATA_DIR: dataDir,
    });
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(0);
  });

  it('fails on http:// webhook URL', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(dataDir, 'merchant.json'), '{"id":"m"}');
    await writeEnvFile(path.join(cwd, '.env'), {
      MERCHANT_XPUB: VALID_ZPUB,
      MERCHANT_WEBHOOK_URL: 'http://insecure.test/hook',
      MERCHANT_WEBHOOK_SECRET: 'whsec_xxxxxxxxxxxxxxxxxx',
      HEALTH_PORT: '8787',
      STORAGE: 'json',
      ZETTAPAY_DATA_DIR: dataDir,
    });
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(1);
  });

  it('passes on http://localhost webhook URL (dev exception)', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(dataDir, 'merchant.json'), '{"id":"m_test"}');
    await writeEnvFile(path.join(cwd, '.env'), {
      MERCHANT_XPUB: VALID_ZPUB,
      MERCHANT_WEBHOOK_URL: 'http://localhost:9876/webhook',
      MERCHANT_WEBHOOK_SECRET: 'whsec_aaaaaaaaaaaaaaaaaa',
      HEALTH_PORT: '8787',
      STORAGE: 'json',
      ZETTAPAY_DATA_DIR: dataDir,
    });
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(0);
  });

  it('passes on http://127.0.0.1 webhook URL (dev exception)', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(dataDir, 'merchant.json'), '{"id":"m_test"}');
    await writeEnvFile(path.join(cwd, '.env'), {
      MERCHANT_XPUB: VALID_ZPUB,
      MERCHANT_WEBHOOK_URL: 'http://127.0.0.1:9876/webhook',
      MERCHANT_WEBHOOK_SECRET: 'whsec_aaaaaaaaaaaaaaaaaa',
      HEALTH_PORT: '8787',
      STORAGE: 'json',
      ZETTAPAY_DATA_DIR: dataDir,
    });
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(0);
  });

  it('fails when xpub is xprv', async () => {
    const cwd = await makeTmpDir();
    const dataDir = await makeTmpDir();
    await fs.writeFile(path.join(dataDir, 'merchant.json'), '{"id":"m"}');
    await writeEnvFile(path.join(cwd, '.env'), {
      MERCHANT_XPUB: 'xprv' + VALID_ZPUB.slice(4),
      MERCHANT_WEBHOOK_URL: 'https://x.test/hook',
      MERCHANT_WEBHOOK_SECRET: 'whsec_yyyyyyyyyyyyyyyyyy',
      HEALTH_PORT: '8787',
      STORAGE: 'json',
      ZETTAPAY_DATA_DIR: dataDir,
    });
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(1);
  });

  it('fails when .env is missing', async () => {
    const cwd = await makeTmpDir();
    const code = await runVerifyConfig([], { cwd });
    expect(code).toBe(1);
  });
});
