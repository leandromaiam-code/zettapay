// Shared invoice-creation logic used by BOTH the CLI (`create-invoice`) and the
// HTTP API (`http-server` POST /invoice). Single source of truth for BIP-84
// derivation + persistence, so the watcher's resync loop picks up an invoice
// created via either path identically.
//
// HR-WALLET-LESS: derives receive addresses from the merchant xpub only.
// HR-PHONE-HOME: no network calls.

import { randomUUID } from 'node:crypto';
import type { StorageAdapter } from './storage/index.js';
import type { Invoice } from './types.js';
import { deriveBip84Address } from './derive-bip84.js';
import { deriveEvmAddress } from './derive-evm.js';
import { formatUsdc, usdToUsdc } from './usdc-pricing.js';

const SATS_PER_BTC = 100_000_000;
export const DEFAULT_EXPIRES_SECONDS = 3600;

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
