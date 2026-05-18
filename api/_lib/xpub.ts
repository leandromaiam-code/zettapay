// Server-side mirror of packages/sdk/src/derive-bip84.ts. The /api functions
// can't import @zettapay/sdk directly (the workspace isn't published and the
// Vercel build doesn't resolve workspace symlinks for serverless functions),
// so we re-implement the same logic here against the root-level
// @scure/bip32 + @noble/hashes + @scure/base deps.
//
// Z53 invariant (HR-CUSTODY): refuses every private extended key (xprv, zprv,
// yprv, tprv, uprv, vprv). The merchant never hands over a key that signs.

import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { ripemd160 } from '@noble/hashes/ripemd160.js';
import { sha256 } from '@noble/hashes/sha2.js';

const VERSIONS = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  xprv: 0x0488ade4,
  yprv: 0x049d7878,
  zprv: 0x04b2430c,
  tpub: 0x043587cf,
  upub: 0x044a5262,
  vpub: 0x045f1cf6,
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

const TESTNET_VERSIONS = new Set<number>([VERSIONS.tpub, VERSIONS.upub, VERSIONS.vpub]);
const MAINNET_VERSIONS = new Set<number>([VERSIONS.xpub, VERSIONS.ypub, VERSIONS.zpub]);

const codec = base58check(sha256);

export type XpubNetwork = 'mainnet' | 'testnet';

export interface ParsedXpub {
  network: XpubNetwork;
  hdkey: HDKey;
  /** Original SLIP-132 prefix, lowercased (e.g. 'zpub'). */
  prefix: string;
}

export class XpubValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function parseMerchantXpub(input: unknown): ParsedXpub {
  if (typeof input !== 'string' || input.length === 0) {
    throw new XpubValidationError('invalid_xpub', 'xpub must be a non-empty string');
  }
  const trimmed = input.trim();
  if (trimmed.length > 200) {
    throw new XpubValidationError('invalid_xpub', 'xpub is too long');
  }
  const prefix = trimmed.slice(0, 4).toLowerCase();
  let decoded: Uint8Array;
  try {
    decoded = codec.decode(trimmed);
  } catch {
    throw new XpubValidationError('invalid_xpub', 'xpub failed base58check decode');
  }
  if (decoded.length !== 78) {
    throw new XpubValidationError('invalid_xpub', 'extended key must decode to 78 bytes');
  }
  const version =
    ((decoded[0] as number) << 24) |
    ((decoded[1] as number) << 16) |
    ((decoded[2] as number) << 8) |
    (decoded[3] as number);
  if (PRIVATE_VERSIONS.has(version)) {
    throw new XpubValidationError(
      'xprv_forbidden',
      'extended PRIVATE key (xprv/zprv/...) is refused — supply only the public xpub/zpub',
    );
  }
  const network: XpubNetwork = TESTNET_VERSIONS.has(version) ? 'testnet' : 'mainnet';
  if (!MAINNET_VERSIONS.has(version) && !TESTNET_VERSIONS.has(version)) {
    throw new XpubValidationError(
      'invalid_xpub',
      `unknown extended-key version 0x${version.toString(16).padStart(8, '0')}`,
    );
  }
  const canonicalVersion = network === 'mainnet' ? VERSIONS.xpub : VERSIONS.tpub;
  const canonical = new Uint8Array(decoded);
  canonical[0] = (canonicalVersion >>> 24) & 0xff;
  canonical[1] = (canonicalVersion >>> 16) & 0xff;
  canonical[2] = (canonicalVersion >>> 8) & 0xff;
  canonical[3] = canonicalVersion & 0xff;
  let hdkey: HDKey;
  try {
    hdkey = HDKey.fromExtendedKey(codec.encode(canonical));
  } catch (cause) {
    throw new XpubValidationError(
      'invalid_xpub',
      `HDKey parse failed: ${(cause as Error).message}`,
    );
  }
  if (!hdkey.publicKey) {
    throw new XpubValidationError('invalid_xpub', 'HDKey has no public component');
  }
  return { network, hdkey, prefix };
}

function bech32EncodeP2wpkh(pubkeyHash: Uint8Array, hrp: string): string {
  const words = [0, ...bech32.toWords(pubkeyHash)];
  return bech32.encode(hrp, words);
}

export interface DerivedReceive {
  path: string;
  index: number;
  address: string;
  network: XpubNetwork;
}

/**
 * Derive the receive-chain BIP-84 child address at m/0/{index} from a parsed
 * account-level xpub/zpub. Returns the bech32 P2WPKH address (bc1... mainnet,
 * tb1... testnet).
 */
export function deriveBip84Receive(parsed: ParsedXpub, index: number): DerivedReceive {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new XpubValidationError(
      'invalid_index',
      `child index must be a non-hardened uint32, got ${index}`,
    );
  }
  const path = `m/0/${index}`;
  const child = parsed.hdkey.derive(path);
  if (!child.publicKey) {
    throw new XpubValidationError('invalid_xpub', 'child node missing public key');
  }
  const pubkeyHash = ripemd160(sha256(child.publicKey));
  const hrp = parsed.network === 'mainnet' ? 'bc' : 'tb';
  return {
    path,
    index,
    address: bech32EncodeP2wpkh(pubkeyHash, hrp),
    network: parsed.network,
  };
}

/** Convenience: parse + derive in one call. */
export function deriveAddressFromXpub(xpub: string, index: number): DerivedReceive {
  return deriveBip84Receive(parseMerchantXpub(xpub), index);
}
