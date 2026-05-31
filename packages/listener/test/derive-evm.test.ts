// EVM derivation vector tests for `@zettapay/listener`. The canonical vectors
// come from the Foundry / Hardhat default mnemonic:
//   "test test test test test test test test test test test junk"
//   m/44'/60'/0'/0/0 = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
//   m/44'/60'/0'/0/1 = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
// These are the addresses every Anvil / Hardhat node prints on boot, so an
// exact match proves the secp256k1 → keccak256 → EIP-55 chain is correct.
//
// The account-level xpub is computed hermetically from the mnemonic here — no
// external secret material, no network.
//
// HR-CUSTODY: extended PRIVATE keys are refused; the test asserts the refusal.

import { describe, expect, it } from 'vitest';
import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync } from '@scure/bip39';
import { deriveEvmAddress, toChecksumAddress } from '../src/derive-evm.js';

const FOUNDRY_MNEMONIC =
  'test test test test test test test test test test test junk';

function fromMnemonic(): HDKey {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(FOUNDRY_MNEMONIC));
}

// Account-level (m/44'/60'/0') extended PUBLIC key.
const EVM_ACCOUNT_XPUB = fromMnemonic().derive("m/44'/60'/0'").publicExtendedKey;
// Account-level extended PRIVATE key — must be rejected.
const EVM_ACCOUNT_XPRV = fromMnemonic().derive("m/44'/60'/0'").privateExtendedKey;

const FOUNDRY_VECTORS = [
  { index: 0, address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  { index: 1, address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' },
] as const;

describe('deriveEvmAddress — Foundry/Hardhat vectors', () => {
  for (const vec of FOUNDRY_VECTORS) {
    it(`m/0/${vec.index} → ${vec.address}`, () => {
      const derived = deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: vec.index });
      expect(derived.address).toBe(vec.address);
      expect(derived.path).toBe(`m/0/${vec.index}`);
      expect(derived.publicKey).toMatch(/^[0-9a-f]{66}$/);
    });
  }

  it('is deterministic across repeated calls', () => {
    const a = deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: 0 });
    const b = deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: 0 });
    expect(a.address).toBe(b.address);
    expect(a.publicKey).toBe(b.publicKey);
  });

  it('emits a valid EIP-55 mixed-case 0x address', () => {
    const { address } = deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: 0 });
    expect(address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    // re-checksumming the lowercased bytes must reproduce the same casing
    const bytes = Uint8Array.from(
      (address.slice(2).match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)),
    );
    expect(toChecksumAddress(bytes)).toBe(address);
  });
});

describe('toChecksumAddress — EIP-55 reference', () => {
  it('checksums the canonical all-caps example', () => {
    // EIP-55 reference vector 0x52908400098527886E0F7030069857D2E4169EE7
    const bytes = Uint8Array.from(
      ('52908400098527886E0F7030069857D2E4169EE7'.match(/.{2}/g) ?? []).map((h) =>
        parseInt(h, 16),
      ),
    );
    expect(toChecksumAddress(bytes)).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
  });
});

describe('deriveEvmAddress — HR-CUSTODY guards', () => {
  it('refuses an extended PRIVATE key (xprv)', () => {
    expect(() => deriveEvmAddress({ xpub: EVM_ACCOUNT_XPRV, index: 0 })).toThrow(
      /PRIVATE|refused/,
    );
  });

  it('refuses a BIP-39 mnemonic / garbage input', () => {
    expect(() => deriveEvmAddress({ xpub: FOUNDRY_MNEMONIC, index: 0 })).toThrow();
  });
});

describe('deriveEvmAddress — index guards', () => {
  it('refuses negative index', () => {
    expect(() => deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: -1 })).toThrow();
  });
  it('refuses non-integer index', () => {
    expect(() => deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: 1.5 })).toThrow();
  });
  it('refuses hardened-range index', () => {
    expect(() =>
      deriveEvmAddress({ xpub: EVM_ACCOUNT_XPUB, index: 0x80000000 }),
    ).toThrow();
  });
});
