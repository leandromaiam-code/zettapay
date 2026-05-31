// Amount-nonce allocation for the fixed-address USDC mode (Z74). When a
// merchant cannot export an xpub (Phantom, MetaMask, Coinbase, App Base all
// refuse), ZettaPay cannot derive a unique receive address per invoice. The
// fallback is a SINGLE fixed receive address shared by every invoice, where the
// PAYER is identified by the exact amount: a per-invoice nonce embedded in the
// low decimal places of the USDC value.
//
// USDC has 6 decimals. We reserve the LAST 4 decimal places as the nonce
// (1..9999) and keep the upper digits as the "base" amount:
//
//   base_units    = round(usd * 1e6) with the last 4 decimal places zeroed
//   amount_units  = base_units + nonce
//
//   $29, nonce 42 → base 29_000000 → amount 29_000042 → "29.000042 USDC"
//
// The maximum surcharge a customer ever pays is +9999 units = +0.009999 USDC
// (~1 cent). The nonce is recovered from the on-chain value by subtracting the
// invoice's base units. At most 9999 invoices can be ACTIVE at once per
// (chain, base amount); the 1-hour TTL recycles nonces back into the pool.
//
// Pure module: no I/O, no network, no storage. HR-PHONE-HOME / HR-CUSTODY safe.

import { randomInt } from 'node:crypto';
import { USDC_DECIMALS, usdToUsdc } from './usdc-pricing.js';
import { toChecksumAddress } from './derive-evm.js';

/** Number of trailing decimal places reserved as the invoice nonce. */
export const NONCE_DECIMALS = 4;
/** Highest nonce value (inclusive). 4 decimal places → 1..9999. */
export const NONCE_MAX = 10 ** NONCE_DECIMALS - 1; // 9999
/** Integer base-unit modulus that isolates the nonce (10^4 = 10000). */
export const NONCE_MODULUS = 10 ** NONCE_DECIMALS; // 10000

// Stride used to walk the nonce space pseudo-randomly (Z76, FIX 6). Stepping by
// a value COPRIME to NONCE_MAX visits every nonce in 1..NONCE_MAX exactly once
// before repeating, so consecutive invoices get non-adjacent nonces and a payer
// cannot guess another invoice's nonce from their own. 9999 = 3²·11·101 and
// 2719 shares no factor with it, so the walk is a full permutation.
export const NONCE_STRIDE = 2719;

// Sanity: the nonce must fit strictly inside the 6-decimal USDC space.
if (NONCE_DECIMALS >= USDC_DECIMALS) {
  throw new Error('evm-amount-nonce: NONCE_DECIMALS must be < USDC_DECIMALS');
}

// Sanity: the stride must be coprime to NONCE_MAX or the walk would skip nonces.
if (gcd(NONCE_STRIDE, NONCE_MAX) !== 1) {
  throw new Error('evm-amount-nonce: NONCE_STRIDE must be coprime to NONCE_MAX');
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

/**
 * Zero the last {@link NONCE_DECIMALS} decimal places of a USD amount and return
 * the integer USDC base units. This is the "base" the nonce is added onto, and
 * the value the watcher subtracts to recover the nonce.
 */
export function baseUnitsForUsd(usd: number): number {
  const raw = usdToUsdc(usd); // rounds to nearest base unit, validates > 0
  return Math.floor(raw / NONCE_MODULUS) * NONCE_MODULUS;
}

/**
 * Allocate the smallest free nonce in 1..NONCE_MAX given the set of currently
 * active nonces. Throws when the pool is exhausted (9999 simultaneous active
 * invoices at the same chain+price) — the caller surfaces this as a 503.
 */
export function allocateNonce(activeNonces: ReadonlySet<number>): number {
  for (let n = 1; n <= NONCE_MAX; n += 1) {
    if (!activeNonces.has(n)) return n;
  }
  throw new Error(
    `evm-amount-nonce: nonce pool exhausted (${NONCE_MAX} active invoices at this chain+price)`,
  );
}

/**
 * Pick a random per-boot offset for {@link allocateNonceShuffled}. Uses the CSPRNG
 * so the nonce walk starts at an unpredictable point each time the listener boots.
 */
export function randomNonceOffset(): number {
  return randomInt(0, NONCE_MAX);
}

/**
 * Allocate a non-sequential nonce in 1..NONCE_MAX (Z76, FIX 6). Walks the space
 * by {@link NONCE_STRIDE} starting from a per-boot `offset`, returning the first
 * free slot. Because the stride is coprime to NONCE_MAX the walk is a full
 * permutation of the pool: it stays unique, never skips a free nonce, and yields
 * values that are hard to guess from a neighbouring invoice. Throws — exactly
 * like {@link allocateNonce} — when all NONCE_MAX slots are taken.
 */
export function allocateNonceShuffled(
  activeNonces: ReadonlySet<number>,
  offset: number,
): number {
  const start = ((Math.trunc(offset) % NONCE_MAX) + NONCE_MAX) % NONCE_MAX;
  for (let k = 0; k < NONCE_MAX; k += 1) {
    const nonce = ((start + k * NONCE_STRIDE) % NONCE_MAX) + 1;
    if (!activeNonces.has(nonce)) return nonce;
  }
  throw new Error(
    `evm-amount-nonce: nonce pool exhausted (${NONCE_MAX} active invoices at this chain+price)`,
  );
}

export interface EncodedAmount {
  /** Exact USDC amount the payer must send, in integer base units. */
  units: bigint;
  /** Integer base units with the nonce digits zeroed. */
  baseUnits: bigint;
  /** The embedded nonce (1..NONCE_MAX). */
  nonce: number;
  /** Human-readable USDC amount, e.g. "29.000042". */
  display: string;
}

/**
 * Encode a USD price + nonce into the exact USDC amount the payer must send.
 * The nonce occupies the last {@link NONCE_DECIMALS} decimals.
 */
export function encodeAmount(usd: number, nonce: number): EncodedAmount {
  if (!Number.isInteger(nonce) || nonce < 1 || nonce > NONCE_MAX) {
    throw new Error(`evm-amount-nonce: nonce must be an integer in 1..${NONCE_MAX}, got ${nonce}`);
  }
  const baseUnits = baseUnitsForUsd(usd);
  const units = baseUnits + nonce;
  return {
    units: BigInt(units),
    baseUnits: BigInt(baseUnits),
    nonce,
    display: formatUnits(units),
  };
}

/**
 * Recover the nonce from a received on-chain value given the invoice's base
 * units. Returns:
 *   - the nonce (1..NONCE_MAX) when the received amount is base + nonce,
 *   - 0 when the received amount equals base exactly (a "round" value carries
 *     no nonce and is therefore ambiguous — the caller treats it as no-match),
 *   - null when the value is below base or its surplus exceeds the nonce range
 *     (i.e. it cannot have come from a nonce-encoded invoice at this base).
 */
export function matchAmount(
  receivedUnits: bigint | number,
  baseUnits: bigint | number,
): number | null {
  const received = BigInt(receivedUnits);
  const base = BigInt(baseUnits);
  if (received < base) return null;
  const surplus = received - base;
  if (surplus > BigInt(NONCE_MAX)) return null;
  return Number(surplus);
}

/**
 * Validate a merchant-supplied fixed receive address (MERCHANT_EVM_ADDRESS) and
 * return its EIP-55 checksummed canonical form. Accepts all-lowercase or
 * all-uppercase 40-hex addresses (no checksum information present) and any
 * mixed-case address whose casing matches the EIP-55 checksum. Throws otherwise.
 */
export function assertChecksumAddress(addr: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
    throw new Error(`invalid EVM address "${addr}" — expected 0x followed by 40 hex chars`);
  }
  const body = addr.slice(2);
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  const checksummed = toChecksumAddress(bytes);
  const isAllLower = body === body.toLowerCase();
  const isAllUpper = body === body.toUpperCase();
  if (!isAllLower && !isAllUpper && addr !== checksummed) {
    throw new Error(`EIP-55 checksum mismatch for "${addr}" — verify you copied it correctly`);
  }
  return checksummed;
}

/** Boolean form of {@link assertChecksumAddress}. */
export function isChecksumAddress(addr: string): boolean {
  try {
    assertChecksumAddress(addr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate an EVM receive address (MERCHANT_EVM_ADDRESS). Requires the 0x + 40
 * hex shape; when the address is mixed-case it MUST satisfy the EIP-55
 * checksum (catches a fat-fingered character). An all-lower / all-upper address
 * carries no checksum and is accepted as-is.
 */
export function isValidEvmAddress(addr: string): boolean {
  if (typeof addr !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(addr)) return false;
  const body = addr.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i += 1) {
    bytes[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return toChecksumAddress(bytes) === addr;
}

/** Render integer USDC base units (6 decimals) as a decimal string. */
function formatUnits(units: number | bigint): string {
  const u = BigInt(units);
  const per = BigInt(10 ** USDC_DECIMALS);
  const whole = u / per;
  const frac = u % per;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return `${whole.toString()}.${fracStr}`;
}
