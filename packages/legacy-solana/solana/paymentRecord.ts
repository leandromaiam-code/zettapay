import { PublicKey } from "@solana/web3.js";

import { ZETTAPAY_PROGRAM_ID } from "./merchantBinding.js";

/**
 * On-chain payment receipt PDA derivation (Z9).
 *
 * Mirror of the `RecordPayment` accounts struct in `programs/zettapay/src/lib.rs`.
 * Seeds MUST stay byte-for-byte aligned with the Rust program — drift here
 * would derive a different PDA on the client than the validator computes,
 * silently breaking receipt lookups.
 */

export const PAYMENT_ID_LEN = 32;
export const TX_SIGNATURE_LEN = 64;

export interface PaymentReceiptAddress {
  pda: PublicKey;
  bump: number;
}

/**
 * Derive the immutable payment receipt PDA from the merchant binding account
 * address and a 32-byte payment id. The id is opaque to the program — clients
 * typically use random bytes or a hash of an external invoice id.
 */
export function derivePaymentPda(
  merchantBinding: PublicKey,
  paymentId: Uint8Array,
  programId: PublicKey = ZETTAPAY_PROGRAM_ID,
): PaymentReceiptAddress {
  if (paymentId.length !== PAYMENT_ID_LEN) {
    throw new Error(
      `payment_id must be exactly ${PAYMENT_ID_LEN} bytes, got ${paymentId.length}`,
    );
  }
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [merchantBinding.toBuffer(), Buffer.from(paymentId)],
    programId,
  );
  return { pda, bump };
}
