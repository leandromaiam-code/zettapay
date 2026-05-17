// Z51 — HD derivation for sweep. Reads ZETTAPAY_MASTER_SEED (BIP-39
// mnemonic) once, caches the HDKey root, exposes per-invoice private key
// derivation against the Z45 paths (m/84'/0'/0'/0/{i} for BTC, m/44'/60'/0'/0/{i}
// for EVM). Used by both /api/_lib/sweep-btc.ts and /api/_lib/sweep-evm.ts.

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';

let cachedRoot: HDKey | null = null;

export class MasterSeedMissingError extends Error {
  constructor() {
    super('ZETTAPAY_MASTER_SEED env var is not set');
    this.name = 'MasterSeedMissingError';
  }
}

export class MasterSeedInvalidError extends Error {
  constructor(reason: string) {
    super(`ZETTAPAY_MASTER_SEED invalid: ${reason}`);
    this.name = 'MasterSeedInvalidError';
  }
}

function loadRoot(): HDKey {
  if (cachedRoot) return cachedRoot;
  const raw = process.env.ZETTAPAY_MASTER_SEED?.trim();
  if (!raw) throw new MasterSeedMissingError();
  const looksLikeMnemonic = raw.split(/\s+/).length >= 12;
  let seed: Uint8Array;
  if (looksLikeMnemonic) {
    if (!validateMnemonic(raw, englishWordlist)) {
      throw new MasterSeedInvalidError('mnemonic failed BIP-39 checksum');
    }
    seed = mnemonicToSeedSync(raw);
  } else {
    const hex = raw.startsWith('0x') ? raw.slice(2) : raw;
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
      throw new MasterSeedInvalidError('not a valid hex seed');
    }
    if (hex.length < 32) {
      throw new MasterSeedInvalidError('seed too short (need >= 16 bytes)');
    }
    seed = Uint8Array.from(Buffer.from(hex, 'hex'));
  }
  cachedRoot = HDKey.fromMasterSeed(seed);
  return cachedRoot;
}

export function deriveChildPrivateKey(derivationPath: string): Uint8Array {
  if (!derivationPath.startsWith('m/')) {
    throw new Error(`invalid derivation path: ${derivationPath}`);
  }
  const child = loadRoot().derive(derivationPath);
  if (!child.privateKey) {
    throw new Error(`derived key has no private component at ${derivationPath}`);
  }
  return child.privateKey;
}

// Test-only — lets the vitest suite hand in a deterministic seed without
// touching process.env.
export function _resetMasterSeedCacheForTests(): void {
  cachedRoot = null;
}
