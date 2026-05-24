import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  generateWebhookSecret,
  parseEnv,
  parseFlags,
  readEnvFile,
  serializeEnv,
  validateXpubFormat,
  writeEnvFile,
  XpubFormatError,
} from '../src/cli/util.js';

const tmpdirs: string[] = [];

async function makeTmpDir(prefix = 'zp-cli-'): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tmpdirs.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(tmpdirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('validateXpubFormat', () => {
  // BIP-84 zpub sample (Trezor test vector — public only)
  const VALID_ZPUB =
    'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';
  const VALID_TPUB =
    'tpubD6NzVbkrYhZ4XgiXtGrdW5XDAPFCL9h7we1vwNCpn8tGbBcgfVYjXyhWo4E1xkh56hjod1RhGjxbaTLV3X4FyWuejifB9jusQ46QzG87VKp';

  it('accepts a real zpub', () => {
    const r = validateXpubFormat(VALID_ZPUB);
    expect(r.prefix).toBe('zpub');
    expect(r.kind).toBe('mainnet');
  });

  it('accepts a tpub as testnet', () => {
    const r = validateXpubFormat(VALID_TPUB);
    expect(r.kind).toBe('testnet');
  });

  it('rejects zprv with explicit private-key message', () => {
    const bad = 'zprv' + VALID_ZPUB.slice(4);
    expect(() => validateXpubFormat(bad)).toThrowError(XpubFormatError);
    try {
      validateXpubFormat(bad);
    } catch (err) {
      expect((err as Error).message).toMatch(/PRIVATE/);
    }
  });

  it('rejects xprv', () => {
    const bad = 'xprv' + VALID_ZPUB.slice(4);
    expect(() => validateXpubFormat(bad)).toThrowError(XpubFormatError);
  });

  it('rejects empty / whitespace input', () => {
    expect(() => validateXpubFormat('')).toThrow();
    expect(() => validateXpubFormat('   ')).toThrow();
  });

  it('rejects mnemonic-shaped input', () => {
    const mnem =
      'abandon ability able about above absent absorb abstract absurd abuse access accident';
    expect(() => validateXpubFormat(mnem)).toThrow(/mnemonic/);
  });

  it('rejects unknown prefix', () => {
    expect(() => validateXpubFormat('aaaa' + VALID_ZPUB.slice(4))).toThrow();
  });
});

describe('generateWebhookSecret', () => {
  it('emits whsec_ prefix with sufficient entropy', () => {
    const s1 = generateWebhookSecret();
    const s2 = generateWebhookSecret();
    expect(s1.startsWith('whsec_')).toBe(true);
    expect(s2.startsWith('whsec_')).toBe(true);
    expect(s1).not.toEqual(s2);
    expect(s1.length).toBeGreaterThanOrEqual(32);
  });
});

describe('parseEnv / serializeEnv round-trip', () => {
  it('preserves simple KV pairs', () => {
    const raw = serializeEnv({ FOO: 'bar', BAZ: 'qux' });
    expect(parseEnv(raw)).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('quotes values with spaces', () => {
    const raw = serializeEnv({ FOO: 'hello world' });
    expect(raw).toMatch(/FOO="hello world"/);
    expect(parseEnv(raw).FOO).toBe('hello world');
  });

  it('drops empty values', () => {
    const raw = serializeEnv({ FOO: 'x', BAR: '' });
    expect(parseEnv(raw)).toEqual({ FOO: 'x' });
  });

  it('ignores comments and blank lines', () => {
    const raw = '# top\n\nFOO=bar\n# tail';
    expect(parseEnv(raw)).toEqual({ FOO: 'bar' });
  });
});

describe('readEnvFile / writeEnvFile', () => {
  it('returns null when missing', async () => {
    const dir = await makeTmpDir();
    expect(await readEnvFile(path.join(dir, '.env'))).toBeNull();
  });

  it('writes with mode 0600', async () => {
    const dir = await makeTmpDir();
    const file = path.join(dir, '.env');
    await writeEnvFile(file, { SECRET: 'whsec_abc' });
    const st = await fs.stat(file);
    // mode bits: just check owner-only (mask 0o077 == 0)
    expect(st.mode & 0o077).toBe(0);
    const back = await readEnvFile(file);
    expect(back).toEqual({ SECRET: 'whsec_abc' });
  });
});

describe('parseFlags', () => {
  it('parses --key value and --key=value', () => {
    const r = parseFlags(['--a', '1', '--b=2', 'pos', '--c']);
    expect(r.flags).toEqual({ a: '1', b: '2', c: true });
    expect(r.positional).toEqual(['pos']);
  });
});
