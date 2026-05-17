// Vercel-lane HD wallet derivation (Z45). Stays self-contained because the
// Vercel install runs with --workspaces=false, so the matching SDK module at
// packages/sdk/src/key-manager.ts (the canonical one used by external clients
// and unit-tested against BIP-84 / BIP-44 vectors) is not reachable from
// here. Logic stays in sync by construction — both files derive against the
// same standards (BIP-39 mnemonic → BIP-32 master → BIP-84 bech32 P2WPKH for
// BTC, BIP-44 Ethereum SLIP-44 coin type 60 with EIP-55 checksum for EVM).

import { HDKey } from '@scure/bip32';
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english';
import { bech32 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/ripemd160.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export type InvoiceChain = 'btc' | 'base' | 'polygon' | 'ethereum';
export type IndexNamespace = 'btc' | 'evm';
export type BitcoinNetwork = 'mainnet' | 'testnet';

export interface DerivedInvoiceAddress {
  chain: InvoiceChain;
  namespace: IndexNamespace;
  index: number;
  path: string;
  address: string;
}

const BTC_ACCOUNT_PATH = "m/84'/0'/0'";
const EVM_ACCOUNT_PATH = "m/44'/60'/0'";
const BECH32_HRP: Record<BitcoinNetwork, string> = { mainnet: 'bc', testnet: 'tb' };
const MAX_INDEX = 0x7fffffff;

export function chainToNamespace(chain: InvoiceChain): IndexNamespace {
  return chain === 'btc' ? 'btc' : 'evm';
}

export function pathFor(chain: InvoiceChain, index: number): string {
  assertIndex(index);
  return chain === 'btc'
    ? `${BTC_ACCOUNT_PATH}/0/${index}`
    : `${EVM_ACCOUNT_PATH}/0/${index}`;
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error(`hd-wallet: derivation index must be 0..2^31-1, got ${index}`);
  }
}

export function mnemonicToMasterKey(mnemonic: string, passphrase = ''): HDKey {
  if (typeof mnemonic !== 'string') {
    throw new Error('hd-wallet: mnemonic must be a string');
  }
  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized, englishWordlist)) {
    // Never include the mnemonic in the error message — checksum failure
    // is enough signal; logging the seed would defeat the Vault hand-off.
    throw new Error('hd-wallet: invalid BIP39 mnemonic (checksum failed)');
  }
  const seed = mnemonicToSeedSync(normalized, passphrase);
  return HDKey.fromMasterSeed(seed);
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return out;
}

function eip55Checksum(lowerHexNoPrefix: string): string {
  const hash = keccak_256(lowerHexNoPrefix);
  let out = '0x';
  for (let i = 0; i < lowerHexNoPrefix.length; i++) {
    const ch = lowerHexNoPrefix[i] as string;
    const nibble = hash[Math.floor(i / 2)] as number;
    const half = i % 2 === 0 ? nibble >> 4 : nibble & 0x0f;
    out += /[0-9]/.test(ch) ? ch : half >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

function derivePub(master: HDKey, path: string): Uint8Array {
  const node = master.derive(path);
  const pub = node.publicKey;
  if (!pub) throw new Error(`hd-wallet: derived node ${path} missing public key`);
  return pub;
}

export function deriveBtcAddress(
  master: HDKey,
  index: number,
  network: BitcoinNetwork = 'mainnet',
): DerivedInvoiceAddress {
  const path = pathFor('btc', index);
  const compressed = derivePub(master, path);
  const pubkeyHash = ripemd160(sha256(compressed));
  const words = [0, ...bech32.toWords(pubkeyHash)];
  const address = bech32.encode(BECH32_HRP[network], words);
  return { chain: 'btc', namespace: 'btc', index, path, address };
}

export function deriveEvmAddress(
  master: HDKey,
  chain: Exclude<InvoiceChain, 'btc'>,
  index: number,
): DerivedInvoiceAddress {
  const path = pathFor(chain, index);
  const compressed = derivePub(master, path);
  const uncompressed = secp256k1.Point.fromBytes(compressed).toBytes(false);
  const hashed = keccak_256(uncompressed.subarray(1));
  const lower = toHex(hashed.subarray(12));
  return { chain, namespace: 'evm', index, path, address: eip55Checksum(lower) };
}

export function deriveAddressFromMaster(
  master: HDKey,
  chain: InvoiceChain,
  index: number,
  network: BitcoinNetwork = 'mainnet',
): DerivedInvoiceAddress {
  return chain === 'btc'
    ? deriveBtcAddress(master, index, network)
    : deriveEvmAddress(master, chain, index);
}
