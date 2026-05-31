// Shared invoice-creation logic used by BOTH the CLI (`create-invoice`) and the
// HTTP API (`http-server` POST /invoice). Single source of truth for BIP-84
// derivation + persistence, so the watcher's resync loop picks up an invoice
// created via either path identically.
//
// HR-WALLET-LESS: derives receive addresses from the merchant xpub only.
// HR-PHONE-HOME: no network calls.

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { Chain, Invoice } from './types.js';
import { deriveBip84Address } from './derive-bip84.js';
import { deriveEvmAddress } from './derive-evm.js';
import { formatUsdc, usdToUsdc } from './usdc-pricing.js';
import {
  allocateNonce,
  baseUnitsForUsd,
  encodeAmount,
  NONCE_MODULUS,
} from './evm-amount-nonce.js';
import { lookupEvmChain } from './fixed-address-watcher.js';

const SATS_PER_BTC = 100_000_000;
export const DEFAULT_EXPIRES_SECONDS = 3600;
/** Fixed-address USDC invoices expire after 1h (nonce recycling, Z74). */
export const FIXED_ADDRESS_EXPIRES_SECONDS = 3600;

export function formatBtcAmount(sats: number): string {
  const whole = Math.floor(sats / SATS_PER_BTC);
  const frac = sats % SATS_PER_BTC;
  if (frac === 0) return `${whole}`;
  const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

export function buildBip21Uri(address: string, sats: number, memo?: string): string {
  const params: string[] = [];
  if (sats > 0) params.push(`amount=${formatBtcAmount(sats)}`);
  if (memo) params.push(`label=${encodeURIComponent(memo)}`);
  return params.length > 0 ? `bitcoin:${address}?${params.join('&')}` : `bitcoin:${address}`;
}

export interface CreateInvoiceParams {
  amountSats: number;
  memo?: string;
  expiresInSeconds?: number;
}

export interface CreateInvoiceResult {
  invoice: Invoice;
  path: string;
  network: 'mainnet' | 'testnet';
  bip21: string;
  amountSats: number;
}

export async function createInvoiceForMerchant(
  storage: StorageAdapter,
  merchantId: string,
  params: CreateInvoiceParams,
): Promise<CreateInvoiceResult> {
  if (!Number.isInteger(params.amountSats) || params.amountSats <= 0) {
    throw new Error('amountSats must be a positive integer');
  }
  const merchant = await storage.getMerchant(merchantId);
  if (!merchant) throw new Error(`merchant "${merchantId}" not found in storage`);

  // Atomically allocate the next child index — the only place it advances.
  const childIndex = await storage.nextChildIndex(merchant.id);
  const derived = deriveBip84Address({ xpub: merchant.xpub, index: childIndex });

  const expiresAt = new Date(
    Date.now() + (params.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS) * 1000,
  ).toISOString();

  const invoice = await storage.createInvoice({
    id: `inv_${randomUUID()}`,
    merchant_id: merchant.id,
    chain: 'btc',
    asset: 'BTC',
    amount: formatBtcAmount(params.amountSats),
    address: derived.address,
    child_index: childIndex,
    expires_at: expiresAt,
  });

  return {
    invoice,
    path: derived.path,
    network: derived.network,
    bip21: buildBip21Uri(derived.address, params.amountSats, params.memo),
    amountSats: params.amountSats,
  };
}

// ---------------------------------------------------------------------------
// Base (USDC) invoice path — fully additive. The BTC path above is untouched:
// nothing here runs unless the caller explicitly asks for chain='base'. The
// merchant's EVM xpub is a SEPARATE key from the BTC xpub and is supplied by
// the caller (sourced from MERCHANT_XPUB_EVM), never read off the merchant
// record, so a BTC-only deployment never needs it.
// ---------------------------------------------------------------------------

/** EIP-681 payment URI for an ERC-20 transfer of USDC on Base (chainId 8453). */
export function buildBaseUsdcUri(
  to: string,
  usdcUnits: number,
  tokenAddress: string,
): string {
  return `ethereum:${tokenAddress}@8453/transfer?address=${to}&uint256=${usdcUnits}`;
}

export interface CreateBaseInvoiceParams {
  amountUsd: number;
  /** Account-level EVM xpub (m/44'/60'/0'). xprv/zprv are refused downstream. */
  evmXpub: string;
  /** USDC token contract used in the payment URI. Defaults to Base mainnet USDC. */
  usdcAddress?: string;
  expiresInSeconds?: number;
}

export interface CreateBaseInvoiceResult {
  invoice: Invoice;
  path: string;
  /** USDC amount in integer base units (6 decimals). */
  amountUsdcUnits: number;
  /** Human-readable USDC amount, trailing zeros stripped. */
  amountUsdc: string;
  /** EIP-681 transfer URI for QR rendering. */
  eip681: string;
}

const BASE_USDC_ADDRESS_DEFAULT = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function createBaseInvoiceForMerchant(
  storage: StorageAdapter,
  merchantId: string,
  params: CreateBaseInvoiceParams,
): Promise<CreateBaseInvoiceResult> {
  const units = usdToUsdc(params.amountUsd);
  const merchant = await storage.getMerchant(merchantId);
  if (!merchant) throw new Error(`merchant "${merchantId}" not found in storage`);

  // Shares the same atomic child-index allocator as the BTC path — each invoice
  // (any chain) consumes the next index, guaranteeing unique receive addresses.
  const childIndex = await storage.nextChildIndex(merchant.id);
  const derived = deriveEvmAddress({ xpub: params.evmXpub, index: childIndex });

  const expiresAt = new Date(
    Date.now() + (params.expiresInSeconds ?? DEFAULT_EXPIRES_SECONDS) * 1000,
  ).toISOString();

  const usdcAddress = params.usdcAddress ?? BASE_USDC_ADDRESS_DEFAULT;
  const invoice = await storage.createInvoice({
    id: `inv_${randomUUID()}`,
    merchant_id: merchant.id,
    chain: 'base',
    asset: 'USDC',
    amount: String(units),
    address: derived.address,
    child_index: childIndex,
    expires_at: expiresAt,
  });

  return {
    invoice,
    path: derived.path,
    amountUsdcUnits: units,
    amountUsdc: formatUsdc(units),
    eip681: buildBaseUsdcUri(derived.address, units, usdcAddress),
  };
}

// ---------------------------------------------------------------------------
// Fixed-address (USDC) invoice path — the SECOND USDC mode (Z74), additive.
// For merchants whose wallet cannot export an xpub (Phantom, MetaMask, App
// Base, Coinbase). One fixed receive address serves every invoice; the payer
// is identified by the EXACT amount — a per-invoice nonce in the low USDC
// decimals (see evm-amount-nonce.ts). Both the BTC path and the xpub Base path
// above are untouched: nothing here runs unless the caller explicitly asks for
// fixed mode (MERCHANT_EVM_ADDRESS set, no xpub for that chain).
// ---------------------------------------------------------------------------

/** EIP-681 USDC transfer URI for an arbitrary EVM chain id. */
export function buildEvmUsdcUri(
  to: string,
  usdcUnits: bigint | number,
  tokenAddress: string,
  chainId: number,
): string {
  return `ethereum:${tokenAddress}@${chainId}/transfer?address=${to}&uint256=${usdcUnits.toString()}`;
}

export interface CreateFixedEvmInvoiceParams {
  amountUsd: number;
  /** Fixed receive address (MERCHANT_EVM_ADDRESS), shared by every invoice. */
  fixedAddress: string;
  /** Chain alias understood by the registry: 'base' | 'ethereum' | 'polygon'. */
  chainAlias: string;
  expiresInSeconds?: number;
}

export interface CreateFixedEvmInvoiceResult {
  invoice: Invoice;
  /** Per-invoice nonce embedded in the amount (1..9999). */
  nonce: number;
  /** Exact USDC amount in integer base units the payer must send. */
  amountUsdcUnits: bigint;
  /** Human-readable USDC amount, e.g. "29.000042". */
  amountUsdc: string;
  /** EIP-681 transfer URI for QR rendering. */
  eip681: string;
}

/**
 * Create a fixed-address USDC invoice. Allocates the smallest free nonce among
 * the merchant's currently-active invoices at the same (chain, base price),
 * encodes it into the exact payment amount, and stores the invoice against the
 * SHARED fixed address. The nonce is fully recoverable from the stored amount
 * (`amount % 10000`), so no extra storage column is required.
 */
export async function createFixedEvmInvoiceForMerchant(
  storage: StorageAdapter,
  merchantId: string,
  params: CreateFixedEvmInvoiceParams,
): Promise<CreateFixedEvmInvoiceResult> {
  const spec = lookupEvmChain(params.chainAlias);
  if (!spec) throw new Error(`fixed-evm: unknown chain "${params.chainAlias}"`);
  if (!/^0x[0-9a-fA-F]{40}$/.test(params.fixedAddress)) {
    throw new Error('fixed-evm: MERCHANT_EVM_ADDRESS must be a 0x EVM address');
  }
  const merchant = await storage.getMerchant(merchantId);
  if (!merchant) throw new Error(`merchant "${merchantId}" not found in storage`);

  const baseUnits = baseUnitsForUsd(params.amountUsd);
  const activeNonces = await collectActiveNonces(
    storage,
    spec.chain,
    params.fixedAddress,
    baseUnits,
  );
  const nonce = allocateNonce(activeNonces);
  const encoded = encodeAmount(params.amountUsd, nonce);

  const expiresAt = new Date(
    Date.now() + (params.expiresInSeconds ?? FIXED_ADDRESS_EXPIRES_SECONDS) * 1000,
  ).toISOString();

  // child_index is null: fixed mode shares one address, so no HD index is
  // consumed (the BTC/xpub allocator is left completely untouched).
  const invoice = await storage.createInvoice({
    id: `inv_${randomUUID()}`,
    merchant_id: merchant.id,
    chain: spec.chain,
    asset: 'USDC',
    amount: encoded.units.toString(),
    address: params.fixedAddress,
    child_index: null,
    expires_at: expiresAt,
  });

  return {
    invoice,
    nonce,
    amountUsdcUnits: encoded.units,
    amountUsdc: encoded.display,
    eip681: buildEvmUsdcUri(params.fixedAddress, encoded.units, spec.usdcAddress, spec.chainId),
  };
}

/**
 * Gather the nonces of currently-ACTIVE fixed-address invoices for a given
 * (chain, fixed address, base price). Only pending invoices that have not
 * expired count — an expired invoice's nonce is free to recycle. The nonce is
 * `amount % 10000`.
 */
async function collectActiveNonces(
  storage: StorageAdapter,
  chain: Chain,
  fixedAddress: string,
  baseUnits: number,
): Promise<Set<number>> {
  const now = Date.now();
  const pending = await storage.listPendingInvoices({ chain });
  const nonces = new Set<number>();
  for (const inv of pending) {
    if (inv.address.toLowerCase() !== fixedAddress.toLowerCase()) continue;
    if (new Date(inv.expires_at).getTime() < now) continue;
    let units: number;
    try {
      units = Number(BigInt(inv.amount));
    } catch {
      continue;
    }
    const base = Math.floor(units / NONCE_MODULUS) * NONCE_MODULUS;
    if (base !== baseUnits) continue;
    const nonce = units - base;
    if (nonce >= 1) nonces.add(nonce);
  }
  return nonces;
}
