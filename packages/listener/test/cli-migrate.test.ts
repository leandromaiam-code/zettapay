import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runMigrate } from '../src/cli/migrate.js';
import { JsonFileStorage } from '../src/storage/json.js';

const tmpdirs: string[] = [];
async function makeTmpDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'zp-migrate-'));
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

async function seedJson(dir: string): Promise<{ merchantId: string; invoiceId: string }> {
  const s = new JsonFileStorage({ dataDir: dir });
  const m = await s.createMerchant({
    shop_name: 'Acme',
    email: 'op@acme.test',
    xpub: VALID_ZPUB,
    webhook_url: 'https://acme.test/hook',
    webhook_secret_hash: 'a'.repeat(64),
  });
  const inv = await s.createInvoice({
    id: 'inv_test_001',
    merchant_id: m.id,
    chain: 'btc',
    asset: 'BTC',
    amount: '0.005',
    address: 'bc1qexample',
    child_index: 0,
    expires_at: new Date(Date.now() + 3600_000).toISOString(),
  });
  return { merchantId: m.id, invoiceId: inv.id };
}

describe('runMigrate', () => {
  it('errors on missing --from / --to', async () => {
    expect(await runMigrate([], {})).toBe(2);
    expect(await runMigrate(['--from', 'json'], {})).toBe(2);
  });

  it('errors when --from === --to', async () => {
    expect(await runMigrate(['--from', 'json', '--to', 'json'], {})).toBe(2);
  });

  it('--dry-run reports counts without writing', async () => {
    const src = await makeTmpDir();
    const dst = await makeTmpDir();
    await seedJson(src);
    const code = await runMigrate(
      [
        '--from', 'json', '--to', 'sqlite',
        '--from-data-dir', src,
        '--to-data-dir', dst,
        '--dry-run',
      ],
      {},
    );
    expect(code).toBe(0);
    // sqlite db should NOT exist
    await expect(fs.access(path.join(dst, 'zettapay.db'))).rejects.toBeTruthy();
  });

  it('json → sqlite → json round-trip preserves merchant + invoice', async () => {
    const a = await makeTmpDir();
    const b = await makeTmpDir();
    const c = await makeTmpDir();
    const seeded = await seedJson(a);

    // json → sqlite
    let code = await runMigrate(
      [
        '--from', 'json', '--to', 'sqlite',
        '--from-data-dir', a,
        '--to-data-dir', b,
      ],
      {},
    );
    expect(code).toBe(0);

    // sqlite → json
    code = await runMigrate(
      [
        '--from', 'sqlite', '--to', 'json',
        '--from-data-dir', b,
        '--to-data-dir', c,
      ],
      {},
    );
    expect(code).toBe(0);

    // Verify final json has same merchant + invoice
    const finalMerchant = JSON.parse(
      await fs.readFile(path.join(c, 'merchant.json'), 'utf8'),
    );
    expect(finalMerchant.id).toBe(seeded.merchantId);
    expect(finalMerchant.xpub).toBe(VALID_ZPUB);

    const finalInvoice = JSON.parse(
      await fs.readFile(path.join(c, 'invoices', `${seeded.invoiceId}.json`), 'utf8'),
    );
    expect(finalInvoice.id).toBe(seeded.invoiceId);
    expect(finalInvoice.amount).toBe('0.005');
  });
});
