import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInit } from '../src/cli/init.js';
import { runCreateInvoice } from '../src/cli/create-invoice.js';
import { parseEnv } from '../src/cli/util.js';

const VALID_ZPUB =
  'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-invoice-'));
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

describe('runCreateInvoice', () => {
  it('allocates child_index 0, writes invoice, prints BIP-21 URI', async () => {
    const { env, dataDir } = await seed();
    const code = await runCreateInvoice(
      ['--amount-sats', '1000', '--memo', 'Coffee'],
      { env },
    );
    expect(code).toBe(0);
    expect(captured).toMatch(/invoice_id:\s+inv_[0-9a-f-]+/i);
    expect(captured).toMatch(/address:\s+bc1[a-z0-9]+/i);
    expect(captured).toMatch(/child_index:\s+0/);
    expect(captured).toMatch(/amount_sats:\s+1000/);
    expect(captured).toMatch(/bip21_uri:\s+bitcoin:bc1[a-z0-9]+\?amount=0\.00001&label=Coffee/i);

    // merchant.next_child_index advanced to 1
    const merchant = JSON.parse(
      await fs.readFile(path.join(dataDir, 'merchant.json'), 'utf8'),
    );
    expect(merchant.next_child_index).toBe(1);

    // invoice was persisted
    const invoiceFiles = (await fs.readdir(path.join(dataDir, 'invoices'))).filter((f) =>
      f.endsWith('.json'),
    );
    expect(invoiceFiles).toHaveLength(1);
    const inv = JSON.parse(
      await fs.readFile(path.join(dataDir, 'invoices', invoiceFiles[0] as string), 'utf8'),
    );
    expect(inv.status).toBe('pending');
    expect(inv.chain).toBe('btc');
    expect(inv.asset).toBe('BTC');
    expect(inv.amount).toBe('0.00001');
    expect(inv.child_index).toBe(0);
  });

  it('allocates monotonically increasing indices across calls', async () => {
    const { env, dataDir } = await seed();
    await runCreateInvoice(['--amount-sats', '500'], { env });
    captured = '';
    const code = await runCreateInvoice(['--amount-sats', '750'], { env });
    expect(code).toBe(0);
    expect(captured).toMatch(/child_index:\s+1/);
    const merchant = JSON.parse(
      await fs.readFile(path.join(dataDir, 'merchant.json'), 'utf8'),
    );
    expect(merchant.next_child_index).toBe(2);
  });

  it('requires --amount-sats', async () => {
    const { env } = await seed();
    const code = await runCreateInvoice([], { env });
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/amount-sats/);
  });

  it('rejects negative amounts', async () => {
    const { env } = await seed();
    const code = await runCreateInvoice(['--amount-sats', '-1'], { env });
    expect(code).toBe(2);
  });

  it('exits 2 with helpful message when MERCHANT_XPUB missing', async () => {
    const code = await runCreateInvoice(['--amount-sats', '100'], { env: {} });
    expect(code).toBe(2);
    expect(capturedErr).toMatch(/MERCHANT_XPUB/);
  });

  it('--help prints usage and exits 0', async () => {
    const code = await runCreateInvoice(['--help'], { env: {} });
    expect(code).toBe(0);
    expect(captured).toMatch(/create-invoice/);
  });
});
