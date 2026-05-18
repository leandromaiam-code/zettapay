// BIP-84 (P2WPKH native segwit) address derivation from an account-level
// extended public key. Accepts both `xpub` (BIP-32 standard version bytes)
// and `zpub` (BIP-84 version bytes 0x04B24746 — re-encoded to xpub before
// passing to @scure/bip32, which only understands the standard version).
//
// Derivation path is m/0/{index} relative to the supplied key — the spec
// assumes the input is at the BIP-84 account level (m/84'/0'/0'). Index is
// the receive-chain child index (external chain only).
//
// Hard rule: this module never accepts xprv / zprv / private keys. Anything
// that decodes to a private-key version byte set is rejected with an error.

import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { ripemd160 } from '@noble/hashes/ripemd160.js';
import { sha256 } from '@noble/hashes/sha2.js';

const VERSION_LEN = 4;

// BIP-32 / SLIP-132 extended-key version bytes.
const VERSIONS = {
  // Mainnet public (accepted, normalized to xpub).
  xpub: 0x0488b21e, // BIP-32 standard
  ypub: 0x049d7cb2, // BIP-49 P2SH-P2WPKH
  zpub: 0x04b24746, // BIP-84 P2WPKH
  // Mainnet private (REJECTED).
  xprv: 0x0488ade4,
  yprv: 0x049d7878,
  zprv: 0x04b2430c,
  // Testnet public (accepted, normalized to tpub).
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
  // Testnet private (REJECTED).
  tprv: 0x04358394,
  uprv: 0x044a4e28,
  vprv: 0x045f18bc,
} as const;

const PRIVATE_VERSIONS = new Set<number>([
  VERSIONS.xprv,
  VERSIONS.yprv,
  VERSIONS.zprv,
  VERSIONS.tprv,
  VERSIONS.uprv,
  VERSIONS.vprv,
]);

const TESTNET_VERSIONS = new Set<number>([
  VERSIONS.tpub,
  VERSIONS.upub,
  VERSIONS.vpub,
]);

const MAINNET_VERSIONS = new Set<number>([
  VERSIONS.xpub,
  VERSIONS.ypub,
  VERSIONS.zpub,
]);

const sha256x2 = base58check(sha256);

export type Bip84Network = 'mainnet' | 'testnet';

export interface Bip84Parsed {
  network: Bip84Network;
  /** True when the input prefix was already zpub/vpub (BIP-84 native segwit). */
  isNativeSegwit: boolean;
  hdkey: HDKey;
}

export interface DeriveBip84Params {
  /** Account-level extended public key. xpub, zpub, ypub (mainnet) or tpub/upub/vpub (testnet). */
  xpub: string;
  /** Non-hardened receive-chain index (m/0/{index}). */
  index: number;
}

export interface DerivedBip84 {
  path: string;
  index: number;
  publicKey: string;
  address: string;
  network: Bip84Network;
}

export function parseExtendedPublicKey(xpub: string): Bip84Parsed {
  if (typeof xpub !== 'string' || xpub.length === 0) {
    throw new Error('xpub: must be a non-empty string');
  }
  const trimmed = xpub.trim();
  let decoded: Uint8Array;
  try {
    decoded = sha256x2.decode(trimmed);
  } catch (cause) {
    throw new Error(`xpub: base58check decode failed (${(cause as Error).message})`);
  }
  if (decoded.length !== 78) {
    throw new Error(`xpub: extended key must decode to 78 bytes, got ${decoded.length}`);
  }
  const version =
    ((decoded[0] as number) << 24) |
    ((decoded[1] as number) << 16) |
    ((decoded[2] as number) << 8) |
    (decoded[3] as number);
  if (PRIVATE_VERSIONS.has(version)) {
    throw new Error('xpub: refused — extended PRIVATE key (xprv/zprv/...) is forbidden');
  }
  const network: Bip84Network = TESTNET_VERSIONS.has(version) ? 'testnet' : 'mainnet';
  if (!MAINNET_VERSIONS.has(version) && !TESTNET_VERSIONS.has(version)) {
    throw new Error(`xpub: unknown version bytes 0x${version.toString(16).padStart(8, '0')}`);
  }
  const isNativeSegwit = version === VERSIONS.zpub || version === VERSIONS.vpub;

  // @scure/bip32 only recognizes the canonical xpub/tpub version bytes — rewrite
  // the version prefix so a zpub/ypub/upub/vpub also parses cleanly. The
  // serialized payload after the version is identical across SLIP-132 variants.
  const canonical = new Uint8Array(decoded.length);
  canonical.set(decoded);
  const canonicalVersion = network === 'mainnet' ? VERSIONS.xpub : VERSIONS.tpub;
  canonical[0] = (canonicalVersion >>> 24) & 0xff;
  canonical[1] = (canonicalVersion >>> 16) & 0xff;
  canonical[2] = (canonicalVersion >>> 8) & 0xff;
  canonical[3] = canonicalVersion & 0xff;

  const reEncoded = sha256x2.encode(canonical);
  let hdkey: HDKey;
  try {
    hdkey = HDKey.fromExtendedKey(reEncoded);
  } catch (cause) {
    throw new Error(`xpub: @scure/bip32 parse failed (${(cause as Error).message})`);
  }
  if (!hdkey.publicKey) {
    throw new Error('xpub: derived HDKey is missing public key');
  }
  return { network, isNativeSegwit, hdkey };
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`derive: index must be a non-hardened uint32, got ${index}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function bech32EncodeP2wpkh(pubkeyHash: Uint8Array, hrp: string): string {
  const words = [0, ...bech32.toWords(pubkeyHash)];
  return bech32.encode(hrp, words);
}

/**
 * Derive the receive-chain BIP-84 child address at m/0/{index}.
 *
 * Returns the P2WPKH (bech32, bc1... / tb1...) address, the compressed public
 * key, the derivation path, and the inferred network. The supplied xpub MUST
 * be at the BIP-84 account level (m/84'/0'/0') — typically a zpub.
 */
export function deriveBip84Address(params: DeriveBip84Params): DerivedBip84 {
  assertIndex(params.index);
  const parsed = parseExtendedPublicKey(params.xpub);
  const path = `m/0/${params.index}`;
  const child = parsed.hdkey.derive(path);
  if (!child.publicKey) {
    throw new Error('derive: child node missing public key');
  }
  const compressed = child.publicKey;
  const pubkeyHash = ripemd160(sha256(compressed));
  const hrp = parsed.network === 'mainnet' ? 'bc' : 'tb';
  const address = bech32EncodeP2wpkh(pubkeyHash, hrp);
  return {
    path,
    index: params.index,
    publicKey: toHex(compressed),
    address,
    network: parsed.network,
  };
}
