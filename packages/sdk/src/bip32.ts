/**
 * BIP32 secp256k1 public-key derivation (Z26.2).
 *
 * Off-chain helper that walks a non-hardened derivation path from a
 * serialized extended public key (xpub/tpub) and exposes the resulting
 * compressed/uncompressed secp256k1 point. Used by the cross-chain
 * helpers (`crosschain.ts`) to materialize BTC + ETH + USDC EVM
 * addresses from a single merchant xpub without ever touching the
 * private key — settling the custody premise (II/14: we never custody
 * funds, addresses are derived deterministically).
 *
 * Hardened steps (index >= 2^31) are intentionally rejected: they
 * require the parent private key, which by definition never leaves the
 * merchant's wallet. Callers must export an xpub already past every
 * hardened level (BIP44 account xpub).
 *
 * Dependencies: only `@noble/curves` (secp256k1 point math) and
 * `@noble/hashes` (HMAC-SHA512, SHA-256, RIPEMD-160). Both are audited,
 * dependency-free, and add ~80KB gzipped.
 */
import { secp256k1 } from '@noble/curves/secp256k1';
import { hmac } from '@noble/hashes/hmac';
import { sha256, sha512 } from '@noble/hashes/sha2';
import { ripemd160 } from '@noble/hashes/ripemd160';

/** secp256k1 scalar field order — `n`. */
const SECP256K1_N: bigint = secp256k1.Point.Fn.ORDER;
/** Hardened-derivation threshold per BIP32 (`0x80000000`). */
export const HARDENED_OFFSET = 0x80000000;
const SERIALIZED_LEN = 78;
const CHECKSUM_LEN = 4;
const CHAIN_CODE_LEN = 32;
const COMPRESSED_PUB_LEN = 33;

/**
 * Canonical xpub version bytes. Matches the values used by Bitcoin Core
 * and every BIP32 implementation. Includes only the legacy P2PKH
 * versions (xpub/tpub) — segwit-flavored prefixes (ypub, zpub, …) are
 * recognized by some wallets but are *not* part of BIP32: they encode
 * the same key with a different version field. We accept those too,
 * surfacing the version as `unknown` so callers can decide whether to
 * trust the xpub source.
 */
export const XPUB_VERSIONS = {
  mainnet: 0x0488b21e,
  testnet: 0x043587cf,
} as const;
export type Bip32Network = keyof typeof XPUB_VERSIONS | 'unknown';

export interface ExtendedPublicKey {
  /** Compressed secp256k1 public key (33 bytes, prefix 0x02 or 0x03). */
  readonly publicKey: Uint8Array;
  /** 32-byte chain code used as HMAC key for child derivation. */
  readonly chainCode: Uint8Array;
  /** Tree depth — 0 for the master xpub, +1 per derivation step. */
  readonly depth: number;
  /** Parent key's HASH160 fingerprint (first 4 bytes). 0 for master. */
  readonly parentFingerprint: number;
  /** Child number of this key in its parent (0 for master). */
  readonly childNumber: number;
  /** Inferred network from the version bytes of the originating xpub. */
  readonly network: Bip32Network;
  /** Raw version bytes from the originating xpub serialization. */
  readonly version: number;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < BASE58_ALPHABET.length; i++) {
    map[BASE58_ALPHABET[i]!] = i;
  }
  return map;
})();

/** Encode raw bytes as Bitcoin base58 (no checksum). */
export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = 0n;
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let out = '';
  while (num > 0n) {
    const r = Number(num % 58n);
    num /= 58n;
    out = BASE58_ALPHABET[r]! + out;
  }
  return '1'.repeat(zeros) + out;
}

/** Decode a Bitcoin base58 string. Throws on invalid characters. */
export function base58Decode(input: string): Uint8Array {
  if (input.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  let num = 0n;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    const idx = BASE58_INDEX[ch];
    if (idx === undefined) {
      throw new Error(`invalid base58 character "${ch}" at position ${i}`);
    }
    num = num * 58n + BigInt(idx);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num & 0xffn));
    num >>= 8n;
  }
  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes, zeros);
  return out;
}

/** Bitcoin "double SHA-256" — sha256(sha256(x)). */
export function sha256d(bytes: Uint8Array): Uint8Array {
  return sha256(sha256(bytes));
}

/** RIPEMD-160(SHA-256(x)) — Bitcoin HASH160. */
export function hash160(bytes: Uint8Array): Uint8Array {
  return ripemd160(sha256(bytes));
}

/** Append a 4-byte sha256d checksum and base58-encode the result. */
export function base58CheckEncode(payload: Uint8Array): string {
  const checksum = sha256d(payload).subarray(0, CHECKSUM_LEN);
  const out = new Uint8Array(payload.length + CHECKSUM_LEN);
  out.set(payload, 0);
  out.set(checksum, payload.length);
  return base58Encode(out);
}

/** Decode + verify a base58check string. Returns the payload sans checksum. */
export function base58CheckDecode(input: string): Uint8Array {
  const bytes = base58Decode(input);
  if (bytes.length < CHECKSUM_LEN + 1) {
    throw new Error('base58check input too short');
  }
  const payload = bytes.subarray(0, bytes.length - CHECKSUM_LEN);
  const checksum = bytes.subarray(bytes.length - CHECKSUM_LEN);
  const expected = sha256d(payload).subarray(0, CHECKSUM_LEN);
  for (let i = 0; i < CHECKSUM_LEN; i++) {
    if (checksum[i] !== expected[i]) {
      throw new Error('base58check checksum mismatch — corrupted or truncated input');
    }
  }
  return payload;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000) +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  ) >>> 0;
}

function writeUInt32BE(view: Uint8Array, offset: number, value: number): void {
  view[offset] = (value >>> 24) & 0xff;
  view[offset + 1] = (value >>> 16) & 0xff;
  view[offset + 2] = (value >>> 8) & 0xff;
  view[offset + 3] = value & 0xff;
}

function inferNetwork(version: number): Bip32Network {
  if (version === XPUB_VERSIONS.mainnet) return 'mainnet';
  if (version === XPUB_VERSIONS.testnet) return 'testnet';
  return 'unknown';
}

/**
 * Validate a byte array is a well-formed SEC1 compressed secp256k1
 * public key: 33 bytes with a 0x02 / 0x03 prefix. Does *not* check the
 * point is on the curve — use `secp256k1.Point.fromBytes` for that.
 */
export function assertCompressedPubKey(bytes: Uint8Array): void {
  if (bytes.length !== COMPRESSED_PUB_LEN) {
    throw new Error(
      `expected 33-byte compressed pubkey, got ${bytes.length} bytes`,
    );
  }
  const prefix = bytes[0];
  if (prefix !== 0x02 && prefix !== 0x03) {
    throw new Error(
      `expected compressed pubkey prefix 0x02/0x03, got 0x${prefix?.toString(16) ?? '??'}`,
    );
  }
}

/**
 * Parse a BIP32-serialized xpub into its constituent fields. Validates
 * length, checksum, and pubkey shape. Hardened (xprv) inputs are
 * rejected — this module is strictly public-key derivation.
 */
export function parseXpub(xpub: string): ExtendedPublicKey {
  const decoded = base58CheckDecode(xpub);
  if (decoded.length !== SERIALIZED_LEN) {
    throw new Error(
      `xpub payload must be exactly ${SERIALIZED_LEN} bytes, got ${decoded.length}`,
    );
  }
  const version = readUInt32BE(decoded, 0);
  const depth = decoded[4]!;
  const parentFingerprint = readUInt32BE(decoded, 5);
  const childNumber = readUInt32BE(decoded, 9);
  const chainCode = decoded.slice(13, 13 + CHAIN_CODE_LEN);
  const keyData = decoded.slice(45, 45 + COMPRESSED_PUB_LEN);

  if (keyData[0] === 0x00) {
    throw new Error('expected extended public key, received extended private key (xprv)');
  }
  assertCompressedPubKey(keyData);
  // Sanity-check the key lies on the curve. `fromBytes` throws otherwise.
  secp256k1.Point.fromBytes(keyData);

  return {
    publicKey: keyData,
    chainCode,
    depth,
    parentFingerprint,
    childNumber,
    network: inferNetwork(version),
    version,
  };
}

/** Serialize an `ExtendedPublicKey` back into the canonical base58check xpub string. */
export function serializeXpub(key: ExtendedPublicKey): string {
  assertCompressedPubKey(key.publicKey);
  if (key.chainCode.length !== CHAIN_CODE_LEN) {
    throw new Error(`chain code must be ${CHAIN_CODE_LEN} bytes`);
  }
  if (key.depth < 0 || key.depth > 0xff) {
    throw new Error(`depth out of range: ${key.depth}`);
  }
  const out = new Uint8Array(SERIALIZED_LEN);
  writeUInt32BE(out, 0, key.version);
  out[4] = key.depth;
  writeUInt32BE(out, 5, key.parentFingerprint);
  writeUInt32BE(out, 9, key.childNumber);
  out.set(key.chainCode, 13);
  out.set(key.publicKey, 45);
  return base58CheckEncode(out);
}

/** Compute the HASH160 fingerprint of a compressed pubkey (first 4 bytes). */
export function fingerprintOf(publicKey: Uint8Array): number {
  const h = hash160(publicKey);
  return readUInt32BE(h, 0);
}

/**
 * BIP32 CKDpub: derive the i-th non-hardened child of `parent`.
 * Hardened indices (i >= 2^31) are rejected — they require the parent
 * private key, which is by design not present in an xpub.
 */
export function deriveChildPub(
  parent: ExtendedPublicKey,
  index: number,
): ExtendedPublicKey {
  if (!Number.isInteger(index) || index < 0 || index > 0xffffffff) {
    throw new Error(`child index out of range: ${index}`);
  }
  if (index >= HARDENED_OFFSET) {
    throw new Error(
      `cannot derive hardened child 0x${index.toString(16)} from an xpub — hardened steps require the parent private key`,
    );
  }
  if (parent.depth >= 0xff) {
    throw new Error('cannot derive beyond depth 255 (BIP32 limit)');
  }

  const data = new Uint8Array(COMPRESSED_PUB_LEN + 4);
  data.set(parent.publicKey, 0);
  writeUInt32BE(data, COMPRESSED_PUB_LEN, index);

  const I = hmac(sha512, parent.chainCode, data);
  const IL = I.subarray(0, 32);
  const IR = I.subarray(32, 64);

  let tweak = 0n;
  for (const b of IL) tweak = (tweak << 8n) | BigInt(b);
  if (tweak === 0n || tweak >= SECP256K1_N) {
    // Per BIP32 this index is invalid; callers are expected to skip.
    // We surface it as a typed error so the caller can decide.
    throw new Error(
      `BIP32 derivation produced invalid scalar at index ${index} — caller should try the next index`,
    );
  }

  const parentPoint = secp256k1.Point.fromBytes(parent.publicKey);
  const childPoint = secp256k1.Point.BASE.multiply(tweak).add(parentPoint);
  // The point-at-infinity case is also defined as invalid by BIP32. The
  // `@noble/curves` API throws on attempts to serialize ZERO via
  // `toRawBytes`, so we explicitly check first for a clear message.
  if (childPoint.is0()) {
    throw new Error(
      `BIP32 derivation produced point-at-infinity at index ${index} — caller should try the next index`,
    );
  }
  const childPublicKey = childPoint.toRawBytes(true);

  return {
    publicKey: childPublicKey,
    chainCode: IR.slice(),
    depth: parent.depth + 1,
    parentFingerprint: fingerprintOf(parent.publicKey),
    childNumber: index,
    network: parent.network,
    version: parent.version,
  };
}

/**
 * Walk a BIP32 path of non-hardened indices, starting from `root`.
 * Accepts both `"m/44/0/0/0/5"` and `"44/0/0/0/5"` and (degenerately)
 * the empty/`"m"` path (returns `root` unchanged).
 */
export function derivePath(
  root: ExtendedPublicKey,
  path: string,
): ExtendedPublicKey {
  const segments = parsePath(path);
  let cursor = root;
  for (const idx of segments) {
    cursor = deriveChildPub(cursor, idx);
  }
  return cursor;
}

/** Tokenize a BIP32 derivation path into a list of non-hardened indices. */
export function parsePath(path: string): number[] {
  const trimmed = path.trim();
  if (trimmed.length === 0 || trimmed === 'm' || trimmed === 'm/' || trimmed === '/') {
    return [];
  }
  const stripped = trimmed.startsWith('m/')
    ? trimmed.slice(2)
    : trimmed.startsWith('/')
      ? trimmed.slice(1)
      : trimmed;
  const segs = stripped.split('/').filter((s) => s.length > 0);
  return segs.map((seg, position) => {
    if (seg.endsWith("'") || seg.endsWith('h') || seg.endsWith('H')) {
      throw new Error(
        `hardened segment "${seg}" at position ${position} cannot be derived from an xpub`,
      );
    }
    if (!/^\d+$/.test(seg)) {
      throw new Error(`invalid path segment "${seg}" at position ${position}`);
    }
    const idx = Number.parseInt(seg, 10);
    if (idx < 0 || idx >= HARDENED_OFFSET) {
      throw new Error(`path segment "${seg}" out of non-hardened range`);
    }
    return idx;
  });
}

/**
 * Uncompress a secp256k1 compressed pubkey to the 64-byte
 * `(x || y)` form required by Ethereum address derivation. The 0x04
 * prefix byte is stripped — Ethereum hashes only the coordinates.
 */
export function uncompressedPubKey(compressed: Uint8Array): Uint8Array {
  assertCompressedPubKey(compressed);
  const point = secp256k1.Point.fromBytes(compressed);
  const raw = point.toRawBytes(false);
  if (raw.length !== 65 || raw[0] !== 0x04) {
    throw new Error('unexpected uncompressed pubkey encoding from secp256k1');
  }
  return raw.subarray(1);
}
