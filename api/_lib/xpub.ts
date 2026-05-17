// Watch-only BIP84 xpub/zpub derivation for ZettaPay BTC P2P invoices.
//
// HR-CUSTODY: this module never accepts or returns any private-key material.
// `xprv` / `zprv` strings are rejected at the boundary. Pubkey-only HD
// derivation lets ZettaPay generate unique receive addresses per invoice
// without ever holding the merchant's signing key.

import { HDKey } from '@scure/bip32';
import { base58check, bech32 } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/ripemd160.js';

const BIP32_XPUB_VERSION = 0x0488b21e; // mainnet xpub
const BIP84_ZPUB_VERSION = 0x04b24746; // mainnet zpub (BIP84 P2WPKH)
const PRIVATE_PREFIXES = ['xprv', 'tprv', 'yprv', 'zprv', 'uprv', 'vprv'];

export type SupportedXpubPrefix = 'xpub' | 'zpub';

const XPUB_PATTERN = /^(zpub|xpub)[1-9A-HJ-NP-Za-km-z]+$/;

export interface ParsedXpub {
  prefix: SupportedXpubPrefix;
  hdkey: HDKey;
}

/** Throws if `material` is a private extended key. Lightweight string-level
 * gate that runs before we even try to base58-decode, so a malformed xprv
 * never reaches the bip32 parser (whose errors leak less context). */
export function rejectPrivateMaterial(material: string): void {
  const head = material.slice(0, 4).toLowerCase();
  if (PRIVATE_PREFIXES.includes(head)) {
    throw new Error('private keys forbidden');
  }
}

/** Parse a serialized BIP32 xpub or BIP84 zpub. zpub re-encodes the bytes
 * under the xpub version (0x0488b21e) before handing to @scure/bip32, which
 * only knows the canonical BIP32 version bytes. The underlying pubkey/chain
 * code is identical — only the version prefix differs. */
export function parseXpub(material: string): ParsedXpub {
  if (typeof material !== 'string' || material.length === 0) {
    throw new Error('xpub must be a non-empty string');
  }
  rejectPrivateMaterial(material);
  if (!XPUB_PATTERN.test(material)) {
    throw new Error('xpub must start with "xpub" or "zpub" and be base58');
  }

  const prefix: SupportedXpubPrefix = material.startsWith('zpub') ? 'zpub' : 'xpub';

  let extended = material;
  if (prefix === 'zpub') {
    // Decode → rewrite version → re-encode under xpub version so @scure/bip32
    // accepts it. base58check enforces checksum, so a typo throws here.
    const bytes = base58check(sha256).decode(material);
    if (bytes.length !== 78) {
      throw new Error('zpub payload must be 78 bytes');
    }
    const seenVersion =
      (bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!;
    if ((seenVersion >>> 0) !== BIP84_ZPUB_VERSION) {
      throw new Error('zpub version bytes mismatch');
    }
    const rewritten = new Uint8Array(bytes);
    rewritten[0] = (BIP32_XPUB_VERSION >>> 24) & 0xff;
    rewritten[1] = (BIP32_XPUB_VERSION >>> 16) & 0xff;
    rewritten[2] = (BIP32_XPUB_VERSION >>> 8) & 0xff;
    rewritten[3] = BIP32_XPUB_VERSION & 0xff;
    extended = base58check(sha256).encode(rewritten);
  }

  let hdkey: HDKey;
  try {
    hdkey = HDKey.fromExtendedKey(extended);
  } catch (cause) {
    throw new Error(`invalid xpub (${(cause as Error).message})`);
  }
  if (!hdkey.publicKey) {
    throw new Error('xpub did not yield a public key');
  }
  return { prefix, hdkey };
}

/** True when `material` parses as a BIP32 xpub or BIP84 zpub. Used by the
 * signup endpoint for shape validation before persisting. */
export function isXpub(material: string): boolean {
  try {
    parseXpub(material);
    return true;
  } catch {
    return false;
  }
}

function assertIndex(index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`derivation index out of range: ${index}`);
  }
}

/** BIP84 P2WPKH bech32 (bc1q...) for the merchant's receive chain.
 *
 * A BIP84 zpub already represents the account-level external chain node at
 * m/84'/0'/0', so we only need to descend `0/<index>` from the xpub root.
 * The same path applies if the merchant supplies an account-level xpub —
 * the address layout follows BIP84 regardless of the version prefix.
 *
 * Returns a Bech32-encoded P2WPKH address. Pure / offline; identical inputs
 * always produce identical outputs (used by the acceptance test to verify
 * server-side derivation matches a fresh client-side re-derivation). */
export function deriveAddress(xpub: string, index: number): string {
  assertIndex(index);
  const parsed = parseXpub(xpub);
  const child = parsed.hdkey.derive(`m/0/${index}`);
  if (!child.publicKey) {
    throw new Error('derived child node missing public key');
  }
  const hash160 = ripemd160(sha256(child.publicKey));
  const words = [0, ...bech32.toWords(hash160)];
  return bech32.encode('bc', words);
}
