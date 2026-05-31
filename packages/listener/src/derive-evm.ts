// EVM (Ethereum / Base) address derivation from an account-level extended
// public key. Mirrors derive-bip84.ts but for the secp256k1 → keccak256 →
// EIP-55 path used by every EVM chain. The supplied xpub is expected to sit at
// the BIP-44 account level m/44'/60'/0'; derivation walks m/0/{index} relative
// to it, i.e. the standard external receive chain m/44'/60'/0'/0/{index}.
//
// HR-CUSTODY: parsing is delegated to parseExtendedPublicKey, which rejects
// every extended PRIVATE key (xprv/zprv/...). This module never accepts or
// touches signing material — only the public xpub.
// HR-WALLET-LESS: produces a destination address; no key is ever held.

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { parseExtendedPublicKey } from './derive-bip84.js';

export interface DeriveEvmParams {
  /** Account-level (m/44'/60'/0') extended PUBLIC key. xprv/zprv are refused. */
  xpub: string;
  /** Non-hardened receive-chain child index. */
  index: number;
}

export interface DerivedEvm {
  path: string;
  index: number;
  /** Compressed secp256k1 public key, hex (66 chars). */
  publicKey: string;
  /** EIP-55 checksummed 0x address. */
  address: string;
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`derive-evm: index must be a non-hardened uint32, got ${index}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/**
 * Apply EIP-55 mixed-case checksum to a 20-byte address. The checksum is
 * derived from keccak256 of the lowercase hex (without the 0x prefix): for each
 * hex nibble, uppercase the corresponding address char when the nibble >= 8.
 */
export function toChecksumAddress(addr20: Uint8Array): string {
  if (addr20.length !== 20) {
    throw new Error(`derive-evm: address must be 20 bytes, got ${addr20.length}`);
  }
  const lower = toHex(addr20);
  const hashHex = toHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < lower.length; i += 1) {
    const ch = lower[i] as string;
    if (ch >= '0' && ch <= '9') {
      out += ch;
    } else {
      out += parseInt(hashHex[i] as string, 16) >= 8 ? ch.toUpperCase() : ch;
    }
  }
  return out;
}

/**
 * Derive the EVM receive address at m/0/{index} relative to the account-level
 * xpub. Returns the EIP-55 checksummed 0x address.
 */
export function deriveEvmAddress(params: DeriveEvmParams): DerivedEvm {
  assertIndex(params.index);
  const parsed = parseExtendedPublicKey(params.xpub);
  const path = `m/0/${params.index}`;
  const child = parsed.hdkey.derive(path);
  if (!child.publicKey) {
    throw new Error('derive-evm: child node missing public key');
  }
  const compressed = child.publicKey;
  // Decompress to the 65-byte uncompressed form (0x04 || x || y), drop the
  // prefix, keccak256 the 64-byte x||y, take the last 20 bytes.
  const point = secp256k1.ProjectivePoint.fromHex(toHex(compressed));
  const uncompressed = point.toRawBytes(false);
  const xy = uncompressed.subarray(1);
  const hashed = keccak_256(xy);
  const addr20 = hashed.subarray(hashed.length - 20);
  return {
    path,
    index: params.index,
    publicKey: toHex(compressed),
    address: toChecksumAddress(addr20),
  };
}
