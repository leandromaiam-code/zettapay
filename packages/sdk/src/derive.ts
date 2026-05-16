import { HDKey } from '@scure/bip32';
import { bech32 } from '@scure/base';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { ripemd160 } from '@noble/hashes/ripemd160.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export type DerivedChain = 'btc' | 'eth' | 'usdc';

export type BitcoinNetwork = 'mainnet' | 'testnet';

export interface DerivedAddress {
  chain: DerivedChain;
  path: string;
  index: number;
  publicKey: string;
  address: string;
}

export interface DeriveBitcoinAddressParams {
  xpub: string;
  index: number;
  network?: BitcoinNetwork;
}

export interface DeriveEthereumAddressParams {
  xpub: string;
  index: number;
}

const BTC_BASE_PATH = 'm/44/0/0/0';
const ETH_BASE_PATH = 'm/44/60/0/0';
const BECH32_HRP: Record<BitcoinNetwork, string> = {
  mainnet: 'bc',
  testnet: 'tb',
};

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`derive: index must be a non-hardened uint32 (0..2^31-1), got ${index}`);
  }
}

function loadXpub(xpub: string): HDKey {
  if (typeof xpub !== 'string' || xpub.length === 0) {
    throw new Error('derive: xpub must be a non-empty base58 string');
  }
  try {
    return HDKey.fromExtendedKey(xpub);
  } catch (cause) {
    throw new Error(`derive: invalid xpub (${(cause as Error).message})`);
  }
}

function deriveCompressedPubkey(xpub: string, basePath: string, index: number): Uint8Array {
  assertIndex(index);
  const root = loadXpub(xpub);
  const child = root.derive(`${basePath}/${index}`);
  const pub = child.publicKey;
  if (!pub) {
    throw new Error('derive: derived node missing public key');
  }
  return pub;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
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

function eip55Checksum(addressLowerNoPrefix: string): string {
  const hash = keccak_256(addressLowerNoPrefix);
  let out = '0x';
  for (let i = 0; i < addressLowerNoPrefix.length; i++) {
    const ch = addressLowerNoPrefix[i] as string;
    const nibble = hash[Math.floor(i / 2)] as number;
    const half = i % 2 === 0 ? nibble >> 4 : nibble & 0x0f;
    out += /[0-9]/.test(ch) ? ch : half >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

export function deriveBitcoinAddress(params: DeriveBitcoinAddressParams): DerivedAddress {
  const network: BitcoinNetwork = params.network ?? 'mainnet';
  const hrp = BECH32_HRP[network];
  const compressed = deriveCompressedPubkey(params.xpub, BTC_BASE_PATH, params.index);
  const pubkeyHash = ripemd160(sha256(compressed));
  const address = bech32EncodeP2wpkh(pubkeyHash, hrp);
  return {
    chain: 'btc',
    path: `${BTC_BASE_PATH}/${params.index}`,
    index: params.index,
    publicKey: toHex(compressed),
    address,
  };
}

export function deriveEthereumAddress(params: DeriveEthereumAddressParams): DerivedAddress {
  const compressed = deriveCompressedPubkey(params.xpub, ETH_BASE_PATH, params.index);
  const uncompressed = uncompressSecp256k1(compressed);
  const hashed = keccak_256(uncompressed.subarray(1));
  const last20 = hashed.subarray(12);
  const lower = toHex(last20);
  return {
    chain: 'eth',
    path: `${ETH_BASE_PATH}/${params.index}`,
    index: params.index,
    publicKey: toHex(compressed),
    address: eip55Checksum(lower),
  };
}

export function deriveUsdcAddress(params: DeriveEthereumAddressParams): DerivedAddress {
  const eth = deriveEthereumAddress(params);
  return { ...eth, chain: 'usdc' };
}

export interface DeriveAddressParams {
  chain: DerivedChain;
  xpub: string;
  index: number;
  network?: BitcoinNetwork;
}

export function deriveAddress(params: DeriveAddressParams): DerivedAddress {
  switch (params.chain) {
    case 'btc':
      return deriveBitcoinAddress({ xpub: params.xpub, index: params.index, network: params.network });
    case 'eth':
      return deriveEthereumAddress({ xpub: params.xpub, index: params.index });
    case 'usdc':
      return deriveUsdcAddress({ xpub: params.xpub, index: params.index });
  }
}
