/**
 * Compile-time mirror of the relevant `MerchantBinding` slice of
 * `idl/zettapay.json`. The discriminator and field offsets are inlined here
 * so the runtime decoder doesn't need an IDL fetch or a JSON import (which
 * would force a NodeNext-only import-attribute on every consumer).
 *
 * Drift between this file and the on-chain program would silently drop
 * accounts in `findByOwner`, so `idl.test.ts` re-reads `idl/zettapay.json`
 * and pins these constants byte-for-byte.
 */

export const ZETTAPAY_PROGRAM_ADDRESS =
  "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS";

export const MERCHANT_BINDING_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  27, 4, 136, 253, 13, 147, 60, 128,
]);

export const PAYMENT_DISCRIMINATOR: Uint8Array = Uint8Array.from([
  227, 231, 51, 26, 244, 88, 4, 148,
]);

/**
 * Byte offsets inside a `MerchantBinding` account's data buffer (post-Anchor
 * 8-byte discriminator). Layout pinned by `programs/zettapay/src/lib.rs`:
 *   [discriminator 8][bump u8][owner pubkey 32][usdc_token_account pubkey 32]
 *   [merchant_handle string (u32 len + utf8)][registered_at i64]
 *
 * Used both for borsh-style decoding and for `memcmp` filters when narrowing
 * `getProgramAccounts` by owner / USDC ATA.
 */
export const MERCHANT_BINDING_OFFSETS = {
  discriminator: 0,
  bump: 8,
  owner: 9,
  usdcTokenAccount: 41,
  merchantHandleLen: 73,
  merchantHandleStart: 77,
} as const;

export const MERCHANT_BINDING_HANDLE_MAX_LEN = 32;
