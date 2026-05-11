import { describe, expect, it } from 'vitest';
import {
  base58CheckDecode,
  base58CheckEncode,
  base58Decode,
  base58Encode,
  deriveChildPub,
  derivePath,
  HARDENED_OFFSET,
  parsePath,
  parseXpub,
  serializeXpub,
  uncompressedPubKey,
} from '../src/bip32.js';

const G_COMPRESSED = Uint8Array.from(
  Buffer.from(
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',
    'hex',
  ),
);

describe('base58 / base58check', () => {
  it('round-trips canonical Bitcoin base58 fixtures', () => {
    const samples = [
      new Uint8Array([0x00]),
      new Uint8Array([0x00, 0x00, 0x01]),
      Uint8Array.from(Buffer.from('00010966776006953D5567439E5E39F86A0D273BEE', 'hex')),
      new Uint8Array(),
    ];
    for (const s of samples) {
      const encoded = base58Encode(s);
      const decoded = base58Decode(encoded);
      expect(Buffer.from(decoded).toString('hex')).toBe(
        Buffer.from(s).toString('hex'),
      );
    }
  });

  it('rejects invalid base58 characters', () => {
    expect(() => base58Decode('0OIl')).toThrow();
  });

  it('rejects corrupted base58check checksums', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const good = base58CheckEncode(bytes);
    // Flip a non-leading character to corrupt the checksum.
    const bad = good.slice(0, -2) + (good.endsWith('A') ? 'B' : 'A');
    expect(() => base58CheckDecode(bad)).toThrow(/checksum/);
  });
});

describe('parseXpub / serializeXpub', () => {
  // BIP32 test vector 1 master xpub.
  const M = 'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8';

  it('decodes mainnet master xpub into the BIP32 fields', () => {
    const parsed = parseXpub(M);
    expect(parsed.depth).toBe(0);
    expect(parsed.parentFingerprint).toBe(0);
    expect(parsed.childNumber).toBe(0);
    expect(parsed.network).toBe('mainnet');
    expect(parsed.publicKey).toHaveLength(33);
    expect(parsed.chainCode).toHaveLength(32);
  });

  it('round-trips serialization losslessly', () => {
    const parsed = parseXpub(M);
    expect(serializeXpub(parsed)).toBe(M);
  });

  it('rejects xprv (private extended keys)', () => {
    const XPRV = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
    expect(() => parseXpub(XPRV)).toThrow(/private/i);
  });
});

describe('deriveChildPub — BIP32 test vector 2', () => {
  const M = 'xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB';
  const M_0 = 'xpub69H7F5d8KSRgmmdJg2KhpAK8SR3DjMwAdkxj3ZuxV27CprR9LgpeyGmXUbC6wb7ERfvrnKZjXoUmmDznezpbZb7ap6r1D3tgFxHmwMkQTPH';

  it('m → m/0 matches the canonical BIP32 vector', () => {
    const root = parseXpub(M);
    const child = deriveChildPub(root, 0);
    expect(serializeXpub(child)).toBe(M_0);
    expect(child.depth).toBe(1);
    expect(child.childNumber).toBe(0);
  });

  it('derivePath("m/0") is equivalent to deriveChildPub(root, 0)', () => {
    const root = parseXpub(M);
    expect(serializeXpub(derivePath(root, 'm/0'))).toBe(M_0);
    expect(serializeXpub(derivePath(root, '0'))).toBe(M_0);
  });

  it('rejects hardened indices at any depth', () => {
    const root = parseXpub(M);
    expect(() => deriveChildPub(root, HARDENED_OFFSET)).toThrow(/hardened/);
    expect(() => derivePath(root, "m/0'")).toThrow(/hardened/);
    expect(() => derivePath(root, 'm/0h')).toThrow(/hardened/);
  });
});

describe('parsePath', () => {
  it('accepts empty, "m", and slash-prefixed paths', () => {
    expect(parsePath('')).toEqual([]);
    expect(parsePath('m')).toEqual([]);
    expect(parsePath('m/')).toEqual([]);
    expect(parsePath('m/44/60/0/0/5')).toEqual([44, 60, 0, 0, 5]);
    expect(parsePath('44/0/0/0/0')).toEqual([44, 0, 0, 0, 0]);
  });

  it('rejects non-numeric or out-of-range segments', () => {
    expect(() => parsePath('m/abc')).toThrow();
    expect(() => parsePath('m/-1')).toThrow();
    expect(() => parsePath(`m/${HARDENED_OFFSET}`)).toThrow();
  });
});

describe('uncompressedPubKey', () => {
  it('strips the 0x04 prefix and returns 64 bytes of (X || Y)', () => {
    const xy = uncompressedPubKey(G_COMPRESSED);
    expect(xy).toHaveLength(64);
    const x = Buffer.from(xy.subarray(0, 32)).toString('hex');
    const y = Buffer.from(xy.subarray(32)).toString('hex');
    // Canonical secp256k1 generator coordinates.
    expect(x).toBe('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
    expect(y).toBe('483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8');
  });
});
