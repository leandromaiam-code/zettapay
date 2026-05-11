/**
 * Cross-chain address derivation (Z26.2).
 *
 * Materializes BTC + ETH + USDC EVM (Base/Polygon/Arbitrum) addresses
 * from a single merchant BIP32 xpub. Uses pure secp256k1 + non-hardened
 * derivation so a merchant can keep the private key in cold storage
 * while ZettaPay generates unlimited fresh deposit addresses per
 * invoice — settles premise II.14 (we never custody funds).
 *
 * Path conventions follow the mission spec:
 *   - BTC:        m/44/0/0/0/{index}
 *   - ETH / USDC: m/44/60/0/0/{index}
 *
 * Note: these are intentionally non-hardened (no `'`) because the
 * caller provides only an xpub. The hardened BIP44 prefix
 * (`m/44'/coin'/account'`) must be applied *before* exporting the xpub.
 * Re-deriving across hardened steps from a public key is mathematically
 * impossible — and that's the whole security model.
 */
import { keccak_256 } from '@noble/hashes/sha3';
import {
  assertCompressedPubKey,
  deriveChildPub,
  derivePath,
  hash160,
  base58CheckEncode,
  uncompressedPubKey,
  parseXpub,
  type ExtendedPublicKey,
} from './bip32.js';

/**
 * Canonical USDC token contract addresses on supported EVM chains. The
 * address scheme is identical to ETH (same EOA derives every EVM
 * chain's deposit address); only the token contract differs.
 *
 * Mainnet addresses sourced from Circle's USDC contract registry:
 *   https://www.circle.com/en/multi-chain-usdc
 */
export const USDC_EVM_CONTRACTS = {
  ethereum: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  base: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  polygon: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  arbitrum: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
  optimism: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
} as const;

export type EvmChain = keyof typeof USDC_EVM_CONTRACTS;

/** BIP44 coin types per SLIP-0044. */
export const BIP44_COIN = {
  bitcoin: 0,
  ethereum: 60,
} as const;

/**
 * Bitcoin P2PKH version bytes:
 *   - mainnet: 0x00 → addresses start with "1…"
 *   - testnet: 0x6f → addresses start with "m…" or "n…"
 */
export const BTC_P2PKH_VERSION = {
  mainnet: 0x00,
  testnet: 0x6f,
} as const;
export type BtcNetwork = keyof typeof BTC_P2PKH_VERSION;

/** Convert raw bytes to lowercase hex (no `0x` prefix). */
function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}

/**
 * Encode a compressed secp256k1 pubkey as a Bitcoin legacy P2PKH
 * address (Base58Check over HASH160 with a version-byte prefix).
 * Native-segwit (bech32) is out of scope for V1 — mainnet support for
 * SPV verifiers in Z26.3/Z26.4 only needs to read P2PKH outputs.
 */
export function compressedPubKeyToBtcAddress(
  compressed: Uint8Array,
  network: BtcNetwork = 'mainnet',
): string {
  assertCompressedPubKey(compressed);
  const h = hash160(compressed);
  const payload = new Uint8Array(1 + h.length);
  payload[0] = BTC_P2PKH_VERSION[network];
  payload.set(h, 1);
  return base58CheckEncode(payload);
}

/**
 * Apply the EIP-55 mixed-case checksum to a 40-character lowercase hex
 * address. The hash is keccak256 of the *lowercase hex string* (UTF-8
 * bytes), and each nibble is uppercased iff the corresponding hex digit
 * of the hash is ≥ 8.
 */
export function toEip55(addressLowerNoPrefix: string): string {
  if (addressLowerNoPrefix.length !== 40 || !/^[0-9a-f]{40}$/.test(addressLowerNoPrefix)) {
    throw new Error('EIP-55 input must be 40 lowercase hex characters');
  }
  const hash = keccak_256(new TextEncoder().encode(addressLowerNoPrefix));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const ch = addressLowerNoPrefix[i]!;
    if (ch >= '0' && ch <= '9') {
      out += ch;
      continue;
    }
    const byte = hash[i >> 1]!;
    const nibble = (i & 1) === 0 ? byte >> 4 : byte & 0x0f;
    out += nibble >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/**
 * Encode a compressed secp256k1 pubkey as an Ethereum address
 * (last-20-bytes of keccak256 over the 64-byte uncompressed pubkey,
 * EIP-55 checksummed).
 */
export function compressedPubKeyToEthAddress(compressed: Uint8Array): string {
  const xy = uncompressedPubKey(compressed);
  const hash = keccak_256(xy);
  const addrLower = bytesToHex(hash.subarray(hash.length - 20));
  return toEip55(addrLower);
}

export interface DeriveOptions {
  /** Bitcoin network (mainnet/testnet). Defaults to mainnet. */
  btcNetwork?: BtcNetwork;
  /**
   * Override the BIP44 path prefix used before the address index. The
   * default reproduces the spec paths `m/44/{coin}/0/0/{index}` — i.e.
   * everything up to (and excluding) the final address index. Provide
   * an array of non-hardened steps to plug in a custom layout.
   */
  pathPrefix?: number[];
}

export interface BitcoinDerivation {
  /** Mainnet/testnet legacy P2PKH address. */
  address: string;
  /** Compressed secp256k1 pubkey backing the address. */
  publicKey: Uint8Array;
  /** Fully-resolved derivation path applied to the xpub. */
  derivationPath: string;
  /** The leaf BIP32 extended public key (so callers can re-derive). */
  extendedPublicKey: ExtendedPublicKey;
}

export interface EthereumDerivation {
  address: string;
  publicKey: Uint8Array;
  derivationPath: string;
  extendedPublicKey: ExtendedPublicKey;
}

export interface UsdcEvmDerivation extends EthereumDerivation {
  chain: EvmChain;
  /** Canonical USDC ERC-20 contract on the target chain. */
  tokenContract: string;
}

function joinPath(prefix: number[], index: number): string {
  return 'm/' + [...prefix, index].join('/');
}

/**
 * Derive the i-th Bitcoin P2PKH deposit address from a merchant xpub.
 *
 * Default path: `m/44/0/0/0/{index}` (all non-hardened — meaning the
 * provided xpub must already encode the BIP44 *account* level, with
 * the hardened steps applied prior to export).
 */
export function deriveBitcoinAddress(
  xpub: string | ExtendedPublicKey,
  index: number,
  options: DeriveOptions = {},
): BitcoinDerivation {
  const root = typeof xpub === 'string' ? parseXpub(xpub) : xpub;
  const prefix = options.pathPrefix ?? [44, BIP44_COIN.bitcoin, 0, 0];
  let cursor: ExtendedPublicKey = root;
  for (const step of prefix) cursor = deriveChildPub(cursor, step);
  const leaf = deriveChildPub(cursor, index);
  const network = options.btcNetwork ?? inferBtcNetwork(root);
  return {
    address: compressedPubKeyToBtcAddress(leaf.publicKey, network),
    publicKey: leaf.publicKey,
    derivationPath: joinPath(prefix, index),
    extendedPublicKey: leaf,
  };
}

/**
 * Derive the i-th Ethereum EOA address from a merchant xpub.
 * Default path: `m/44/60/0/0/{index}`.
 */
export function deriveEthereumAddress(
  xpub: string | ExtendedPublicKey,
  index: number,
  options: DeriveOptions = {},
): EthereumDerivation {
  const root = typeof xpub === 'string' ? parseXpub(xpub) : xpub;
  const prefix = options.pathPrefix ?? [44, BIP44_COIN.ethereum, 0, 0];
  const leaf = derivePath(root, joinPath(prefix, index));
  return {
    address: compressedPubKeyToEthAddress(leaf.publicKey),
    publicKey: leaf.publicKey,
    derivationPath: joinPath(prefix, index),
    extendedPublicKey: leaf,
  };
}

export interface UsdcDeriveOptions extends DeriveOptions {
  /** EVM chain whose USDC contract should be returned. Defaults to `base`. */
  chain?: EvmChain;
}

/**
 * Derive the i-th USDC deposit address on an EVM chain. The address is
 * the same EOA as the Ethereum derivation — USDC is ERC-20, so the EVM
 * scheme is shared across all chains. Only the token contract address
 * changes per chain.
 */
export function deriveUsdcEvmAddress(
  xpub: string | ExtendedPublicKey,
  index: number,
  options: UsdcDeriveOptions = {},
): UsdcEvmDerivation {
  const chain = options.chain ?? 'base';
  const eth = deriveEthereumAddress(xpub, index, options);
  return {
    ...eth,
    chain,
    tokenContract: USDC_EVM_CONTRACTS[chain],
  };
}

function inferBtcNetwork(root: ExtendedPublicKey): BtcNetwork {
  return root.network === 'testnet' ? 'testnet' : 'mainnet';
}
