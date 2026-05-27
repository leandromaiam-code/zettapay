// BIP-84 derivation vector tests for `@zettapay/listener`. The mainnet pair
// (zpub + addresses) comes directly from the spec:
//   https://github.com/bitcoin/bips/blob/master/bip-0084.mediawiki
// Pinning that pair catches any silent regression in HRP, key encoding, or
// hash chain ordering.
//
// HR-CUSTODY: extended PRIVATE keys are refused at parse time; the tests
// below assert the refusal explicitly so a future refactor can't unwind that
// guard without turning red.

import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { base58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { deriveBip84Address, parseExtendedPublicKey } from '../src/derive-bip84.js';

const sha256x2 = base58check(sha256);

// --- Official BIP-84 mainnet test vector ------------------------------------
// Seed: abandon abandon abandon abandon abandon abandon abandon abandon
//       abandon abandon abandon about (BIP-39 test mnemonic, empty passphrase)
// Account path: m/84'/0'/0'
const BIP84_ZPUB =
  'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const BIP84_EXPECTED = [
  { index: 0, address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' },
  { index: 1, address: 'bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g' },
] as const;

// Build a synthetic testnet vpub from a fixed seed so the testnet HRP path is
// exercised without depending on an external faucet. Re-encodes a known xpub
// with vpub version bytes (0x045f1cf6) — this matches how Sparrow Wallet emits
// testnet output to users, so the parser is exercised against the exact shape
// it'll see in production.
function buildTestnetVpubFromXpub(xpub: string): string {
  const decoded = sha256x2.decode(xpub.trim());
  const out = new Uint8Array(decoded);
  const vpubVersion = 0x045f1cf6;
  out[0] = (vpubVersion >>> 24) & 0xff;
  out[1] = (vpubVersion >>> 16) & 0xff;
  out[2] = (vpubVersion >>> 8) & 0xff;
  out[3] = vpubVersion & 0xff;
  return sha256x2.encode(out);
}

// HDKey-derived xpub from the BIP-39 test seed so the round-trip is fully
// hermetic — no external secret material.
const TESTNET_VPUB = buildTestnetVpubFromXpub(BIP84_ZPUB);

describe('deriveBip84Address — BIP-84 mainnet vectors', () => {
  for (const vec of BIP84_EXPECTED) {
    it(`m/0/${vec.index} → ${vec.address}`, () => {
      const derived = deriveBip84Address({ xpub: BIP84_ZPUB, index: vec.index });
      expect(derived.address).toBe(vec.address);
      expect(derived.path).toBe(`m/0/${vec.index}`);
      expect(derived.network).toBe('mainnet');
      expect(derived.publicKey).toMatch(/^[0-9a-f]{66}$/);
    });
  }

  it('derives consistent addresses across repeated calls (no internal state)', () => {
    const a = deriveBip84Address({ xpub: BIP84_ZPUB, index: 0 });
    const b = deriveBip84Address({ xpub: BIP84_ZPUB, index: 0 });
    expect(a.address).toBe(b.address);
    expect(a.publicKey).toBe(b.publicKey);
  });
});

describe('deriveBip84Address — testnet vpub', () => {
  it('emits a tb1q... address when fed a vpub', () => {
    const derived = deriveBip84Address({ xpub: TESTNET_VPUB, index: 0 });
    expect(derived.address.startsWith('tb1q')).toBe(true);
    expect(derived.network).toBe('testnet');
  });

  it('honors explicit HRP override → bcrt1q on regtest', () => {
    const derived = deriveBip84Address({ xpub: TESTNET_VPUB, index: 0, hrp: 'bcrt' });
    expect(derived.address.startsWith('bcrt1q')).toBe(true);
  });

  it('mainnet zpub + explicit testnet HRP override → tb1q', () => {
    // Signet/regtest reuse testnet rules but live on a different HRP. The
    // override knob is the contract the CLI relies on for `--network signet`.
    const derived = deriveBip84Address({ xpub: BIP84_ZPUB, index: 0, hrp: 'tb' });
    expect(derived.address.startsWith('tb1q')).toBe(true);
  });
});

describe('parseExtendedPublicKey — HR-CUSTODY guards', () => {
  it('refuses xprv (mainnet extended private)', () => {
    const xprv =
      'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';
    expect(() => parseExtendedPublicKey(xprv)).toThrow(/PRIVATE|refused/);
  });

  it('refuses zprv (mainnet BIP-84 extended private)', () => {
    // Built by re-encoding the known zpub with the zprv version bytes —
    // sufficient for the prefix-check, even though the payload bytes are
    // still the public key.
    const decoded = sha256x2.decode(BIP84_ZPUB);
    const tampered = new Uint8Array(decoded);
    const zprv = 0x04b2430c;
    tampered[0] = (zprv >>> 24) & 0xff;
    tampered[1] = (zprv >>> 16) & 0xff;
    tampered[2] = (zprv >>> 8) & 0xff;
    tampered[3] = zprv & 0xff;
    const reEncoded = sha256x2.encode(tampered);
    expect(() => parseExtendedPublicKey(reEncoded)).toThrow(/PRIVATE|refused/);
  });

  it('refuses tprv (testnet extended private)', () => {
    const decoded = sha256x2.decode(BIP84_ZPUB);
    const tampered = new Uint8Array(decoded);
    const tprv = 0x04358394;
    tampered[0] = (tprv >>> 24) & 0xff;
    tampered[1] = (tprv >>> 16) & 0xff;
    tampered[2] = (tprv >>> 8) & 0xff;
    tampered[3] = tprv & 0xff;
    const reEncoded = sha256x2.encode(tampered);
    expect(() => parseExtendedPublicKey(reEncoded)).toThrow(/PRIVATE|refused/);
  });

  it('refuses empty input', () => {
    expect(() => parseExtendedPublicKey('')).toThrow();
  });

  it('refuses obviously malformed base58 garbage', () => {
    expect(() => parseExtendedPublicKey('not-a-valid-xpub!!!')).toThrow();
  });

  it('refuses truncated extended-key bytes', () => {
    const truncated = BIP84_ZPUB.slice(0, 50);
    expect(() => parseExtendedPublicKey(truncated)).toThrow();
  });
});

describe('deriveBip84Address — guard rails', () => {
  it('refuses negative index', () => {
    expect(() => deriveBip84Address({ xpub: BIP84_ZPUB, index: -1 })).toThrow();
  });

  it('refuses non-integer index', () => {
    expect(() => deriveBip84Address({ xpub: BIP84_ZPUB, index: 1.5 })).toThrow();
  });

  it('refuses hardened-range index (>= 0x80000000)', () => {
    // BIP-32 forbids hardened derivation from public material. Public-only
    // hdkey.derive() would throw — we surface that upfront.
    expect(() => deriveBip84Address({ xpub: BIP84_ZPUB, index: 0x80000000 })).toThrow();
  });
});

describe('parseExtendedPublicKey — sanity HDKey round-trip', () => {
  // Pure sanity: the parse step must hand us a working HDKey. If @scure/bip32
  // ever ships a breaking version this test fails before any vectors do.
  it('parses canonical xpub-form back to HDKey', () => {
    const parsed = parseExtendedPublicKey(BIP84_ZPUB);
    expect(parsed.hdkey).toBeInstanceOf(HDKey);
    expect(parsed.hdkey.publicKey).toBeDefined();
    expect(parsed.network).toBe('mainnet');
    expect(parsed.isNativeSegwit).toBe(true);
  });
});
