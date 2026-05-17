// HD wallet master-seed → per-invoice receive address derivation (Z45).
//
// ZettaPay 2.0 architecture: every invoice owns a unique on-chain address
// derived deterministically from a single offline-generated BIP39 master
// mnemonic. The listener watches each address; one address = one invoice =
// one detectable TX, with no memo/reference field required.
//
// Derivation paths follow the cross-wallet standards so an operator can
// recover funds from any BIP39/BIP84/BIP44-compatible wallet (Sparrow,
// Electrum, Metamask) using only the master mnemonic + path:
//
//   BTC : m/84'/0'/0'/0/{index}   bech32 P2WPKH (native segwit)
//   EVM : m/44'/60'/0'/0/{index}  Metamask-compatible, same address across
//                                 Base / Polygon / Ethereum (chain-agnostic)
//
// This module never persists the master seed and never logs it — callers
// hold the HDKey root in memory and zero it via process termination.

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

export interface IndexAllocator {
  allocate(namespace: IndexNamespace): Promise<number>;
}

export interface KeyManagerOptions {
  mnemonic: string;
  passphrase?: string;
  network?: BitcoinNetwork;
  allocator: IndexAllocator;
}

const BTC_ACCOUNT_PATH = "m/84'/0'/0'";
const EVM_ACCOUNT_PATH = "m/44'/60'/0'";
const BECH32_HRP: Record<BitcoinNetwork, string> = {
  mainnet: 'bc',
  testnet: 'tb',
};
const MAX_INDEX = 0x7fffffff;

export function chainToNamespace(chain: InvoiceChain): IndexNamespace {
  return chain === 'btc' ? 'btc' : 'evm';
}

export function btcPathFor(index: number): string {
  assertIndex(index);
  return `${BTC_ACCOUNT_PATH}/0/${index}`;
}

export function evmPathFor(index: number): string {
  assertIndex(index);
  return `${EVM_ACCOUNT_PATH}/0/${index}`;
}

export function pathFor(chain: InvoiceChain, index: number): string {
  return chain === 'btc' ? btcPathFor(index) : evmPathFor(index);
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index > MAX_INDEX) {
    throw new Error(`KeyManager: derivation index must be 0..2^31-1, got ${index}`);
  }
}

export function mnemonicToMasterKey(mnemonic: string, passphrase = ''): HDKey {
  if (typeof mnemonic !== 'string') {
    throw new Error('KeyManager: mnemonic must be a string');
  }
  const normalized = mnemonic.trim().replace(/\s+/g, ' ');
  if (!validateMnemonic(normalized, englishWordlist)) {
    // Never include the mnemonic in the error — checksum failure is enough
    // signal for the operator. Logging the seed would defeat the entire
    // point of holding it in Supabase Vault.
    throw new Error('KeyManager: invalid BIP39 mnemonic (checksum failed)');
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

function uncompressSecp256k1(compressed: Uint8Array): Uint8Array {
  return secp256k1.Point.fromBytes(compressed).toBytes(false);
}

function bech32EncodeP2wpkh(pubkeyHash: Uint8Array, hrp: string): string {
  const words = [0, ...bech32.toWords(pubkeyHash)];
  return bech32.encode(hrp, words);
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

function derivePublicKey(master: HDKey, path: string): Uint8Array {
  const node = master.derive(path);
  const pub = node.publicKey;
  if (!pub) {
    throw new Error(`KeyManager: derived node at ${path} missing public key`);
  }
  return pub;
}

export function deriveBtcAddressFromMaster(
  master: HDKey,
  index: number,
  network: BitcoinNetwork = 'mainnet',
): DerivedInvoiceAddress {
  const path = btcPathFor(index);
  const compressed = derivePublicKey(master, path);
  const pubkeyHash = ripemd160(sha256(compressed));
  const address = bech32EncodeP2wpkh(pubkeyHash, BECH32_HRP[network]);
  return { chain: 'btc', namespace: 'btc', index, path, address };
}

export function deriveEvmAddressFromMaster(
  master: HDKey,
  chain: Exclude<InvoiceChain, 'btc'>,
  index: number,
): DerivedInvoiceAddress {
  const path = evmPathFor(index);
  const compressed = derivePublicKey(master, path);
  const uncompressed = uncompressSecp256k1(compressed);
  const hashed = keccak_256(uncompressed.subarray(1));
  const last20 = hashed.subarray(12);
  const address = eip55Checksum(toHex(last20));
  return { chain, namespace: 'evm', index, path, address };
}

export function deriveAddressFromMaster(
  master: HDKey,
  chain: InvoiceChain,
  index: number,
  network: BitcoinNetwork = 'mainnet',
): DerivedInvoiceAddress {
  if (chain === 'btc') {
    return deriveBtcAddressFromMaster(master, index, network);
  }
  return deriveEvmAddressFromMaster(master, chain, index);
}

export class KeyManager {
  private readonly master: HDKey;
  private readonly network: BitcoinNetwork;
  private readonly allocator: IndexAllocator;

  constructor(options: KeyManagerOptions) {
    if (!options || typeof options !== 'object') {
      throw new Error('KeyManager: options required');
    }
    if (!options.allocator) {
      throw new Error('KeyManager: allocator required');
    }
    this.master = mnemonicToMasterKey(options.mnemonic, options.passphrase ?? '');
    this.network = options.network ?? 'mainnet';
    this.allocator = options.allocator;
  }

  /**
   * Allocate the next index from the chain's namespace and derive the address.
   * Atomic — concurrent callers receive distinct indexes from the allocator.
   */
  async deriveNext(chain: InvoiceChain): Promise<DerivedInvoiceAddress> {
    const namespace = chainToNamespace(chain);
    const index = await this.allocator.allocate(namespace);
    return deriveAddressFromMaster(this.master, chain, index, this.network);
  }

  /**
   * Re-derive the address for an existing path. Idempotent — does not touch
   * the allocator. Used by the listener and sweep cron to map a TX back to
   * its invoice without trusting persisted address strings.
   */
  deriveByPath(chain: InvoiceChain, path: string): DerivedInvoiceAddress {
    const expectedPrefix = chain === 'btc' ? `${BTC_ACCOUNT_PATH}/0/` : `${EVM_ACCOUNT_PATH}/0/`;
    if (!path.startsWith(expectedPrefix)) {
      throw new Error(`KeyManager: path ${path} does not match ${chain} derivation scheme`);
    }
    const indexStr = path.slice(expectedPrefix.length);
    const index = Number.parseInt(indexStr, 10);
    if (!Number.isInteger(index) || String(index) !== indexStr) {
      throw new Error(`KeyManager: path ${path} index segment is not a uint32`);
    }
    return deriveAddressFromMaster(this.master, chain, index, this.network);
  }

  /** Network the BTC addresses are encoded for. */
  get bitcoinNetwork(): BitcoinNetwork {
    return this.network;
  }
}

/**
 * In-memory allocator — tests and local development. Production wires a
 * Postgres-backed allocator that calls public.zettapay_allocate_invoice_index().
 */
export class InMemoryIndexAllocator implements IndexAllocator {
  private readonly counters: Record<IndexNamespace, number> = { btc: 0, evm: 0 };

  async allocate(namespace: IndexNamespace): Promise<number> {
    const current = this.counters[namespace];
    this.counters[namespace] = current + 1;
    return current;
  }

  peek(namespace: IndexNamespace): number {
    return this.counters[namespace];
  }
}
