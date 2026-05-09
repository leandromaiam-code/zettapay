import { PublicKey } from "@solana/web3.js";

/**
 * On-chain ZettaPay merchant binding program (Z9).
 *
 * Mirror of `programs/zettapay/src/lib.rs`. The seed contract MUST stay in
 * sync with the Rust program: any drift would derive a different PDA on the
 * client than the validator computes, silently breaking lookups.
 */
export const ZETTAPAY_PROGRAM_ID = new PublicKey(
  "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS",
);

export const MERCHANT_HANDLE_MIN_LEN = 3;
export const MERCHANT_HANDLE_MAX_LEN = 32;

const HANDLE_FIRST_CHAR = /^[a-z0-9]$/;
const HANDLE_TAIL_CHAR = /^[a-z0-9_-]+$/;

export function isValidMerchantHandle(handle: string): boolean {
  if (handle.length < MERCHANT_HANDLE_MIN_LEN) return false;
  if (handle.length > MERCHANT_HANDLE_MAX_LEN) return false;
  if (!HANDLE_FIRST_CHAR.test(handle[0]!)) return false;
  return HANDLE_TAIL_CHAR.test(handle);
}

export interface MerchantBindingAddress {
  pda: PublicKey;
  bump: number;
}

/**
 * Derive the immutable merchant binding PDA. Seeds match the Rust
 * `RegisterMerchant` accounts struct exactly: `[handle_bytes, owner_bytes]`.
 */
export function deriveMerchantBindingPda(
  merchantHandle: string,
  owner: PublicKey,
  programId: PublicKey = ZETTAPAY_PROGRAM_ID,
): MerchantBindingAddress {
  if (!isValidMerchantHandle(merchantHandle)) {
    throw new Error(
      `merchant handle "${merchantHandle}" violates on-chain constraints`,
    );
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(merchantHandle, "utf8"), owner.toBuffer()],
    programId,
  );
  return { pda, bump };
}
