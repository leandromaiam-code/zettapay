//! Program-Derived Address derivation.
//!
//! Seeds are duplicated verbatim by the off-chain SDK
//! (`packages/sdk/src/onchain.ts::deriveInvoicePda`). Any change here must
//! be mirrored there or the SDK will quote an address the program rejects
//! as `InvoicePdaMismatch` — silently broken until the first transaction
//! is built.
//!
//! Seed schemes:
//!
//!   Merchant: seeds = [b"merchant", master_pubkey]
//!   Invoice:  seeds = [master_pubkey, invoice_index_le]   // u64 little-endian
//!
//! The `b"merchant"` prefix prevents an `[master, x]` invoice from ever
//! colliding with a `[b"merchant", master]` merchant — the ASCII bytes
//! cannot be the first 8 bytes of any pubkey the SDK could produce.

use solana_program::pubkey::Pubkey;

pub const MERCHANT_SEED: &[u8] = b"merchant";

/// Width of the `invoice_index` PDA seed. Matches `INVOICE_INDEX_SEED_LEN`
/// in `packages/sdk/src/onchain.ts`.
pub const INVOICE_INDEX_SEED_LEN: usize = 8;

/// Derive the Merchant PDA. Returns `(pda, bump)`; the bump is required
/// by `invoke_signed` at account-creation time so the caller doesn't have
/// to re-derive.
pub fn find_merchant_pda(master_pubkey: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MERCHANT_SEED, master_pubkey.as_ref()],
        program_id,
    )
}

/// Derive the Invoice PDA for a `(master_pubkey, invoice_index)` pair.
///
/// `invoice_index` is serialized as little-endian u64 to match the SDK's
/// `Buffer.writeBigUInt64LE` so off-chain address prediction stays
/// byte-for-byte identical.
pub fn find_invoice_pda(
    master_pubkey: &Pubkey,
    invoice_index: u64,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let index_seed = invoice_index.to_le_bytes();
    Pubkey::find_program_address(
        &[master_pubkey.as_ref(), &index_seed],
        program_id,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_program_id() -> Pubkey {
        Pubkey::new_from_array([42u8; 32])
    }

    #[test]
    fn merchant_pda_is_deterministic() {
        let program_id = fixed_program_id();
        let master = Pubkey::new_from_array([1u8; 32]);
        let (a, bump_a) = find_merchant_pda(&master, &program_id);
        let (b, bump_b) = find_merchant_pda(&master, &program_id);
        assert_eq!(a, b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn different_masters_yield_different_merchant_pdas() {
        let program_id = fixed_program_id();
        let m1 = Pubkey::new_from_array([1u8; 32]);
        let m2 = Pubkey::new_from_array([2u8; 32]);
        let (pda1, _) = find_merchant_pda(&m1, &program_id);
        let (pda2, _) = find_merchant_pda(&m2, &program_id);
        assert_ne!(pda1, pda2);
    }

    #[test]
    fn invoice_pda_is_deterministic() {
        let program_id = fixed_program_id();
        let master = Pubkey::new_from_array([5u8; 32]);
        let (a, _) = find_invoice_pda(&master, 7, &program_id);
        let (b, _) = find_invoice_pda(&master, 7, &program_id);
        assert_eq!(a, b);
    }

    #[test]
    fn invoice_pda_differs_per_index() {
        let program_id = fixed_program_id();
        let master = Pubkey::new_from_array([5u8; 32]);
        let (a, _) = find_invoice_pda(&master, 0, &program_id);
        let (b, _) = find_invoice_pda(&master, 1, &program_id);
        assert_ne!(a, b);
    }

    #[test]
    fn invoice_pda_differs_per_master() {
        let program_id = fixed_program_id();
        let m1 = Pubkey::new_from_array([10u8; 32]);
        let m2 = Pubkey::new_from_array([11u8; 32]);
        let (a, _) = find_invoice_pda(&m1, 0, &program_id);
        let (b, _) = find_invoice_pda(&m2, 0, &program_id);
        assert_ne!(a, b);
    }

    #[test]
    fn invoice_pda_uses_little_endian_index() {
        // The SDK uses `writeBigUInt64LE`. If on-chain ever switched to
        // big-endian, indices >= 256 would derive different addresses
        // without any compile-time signal. Spot-check index=256 against
        // its hand-encoded little-endian seed.
        let program_id = fixed_program_id();
        let master = Pubkey::new_from_array([13u8; 32]);
        let (derived, _) = find_invoice_pda(&master, 256, &program_id);

        let mut le_seed = [0u8; 8];
        le_seed[1] = 1; // little-endian 256
        let (manual, _) = Pubkey::find_program_address(
            &[master.as_ref(), &le_seed],
            &program_id,
        );
        assert_eq!(derived, manual);
    }

    #[test]
    fn invoice_pda_cannot_collide_with_merchant_pda_for_same_master() {
        // The `b"merchant"` prefix on the Merchant seeds is the structural
        // guard against `[master, x]` invoice seeds ever colliding with
        // `[b"merchant", master]` merchant seeds. Spot-check with a
        // hand-picked invoice index.
        let program_id = fixed_program_id();
        let master = Pubkey::new_from_array([17u8; 32]);
        let (merchant_pda, _) = find_merchant_pda(&master, &program_id);
        let (invoice_pda, _) = find_invoice_pda(&master, 0, &program_id);
        assert_ne!(merchant_pda, invoice_pda);
    }

    #[test]
    fn invoice_index_seed_len_matches_u64_width() {
        // INVOICE_INDEX_SEED_LEN must equal mem::size_of::<u64>(). Both
        // the on-chain `idx.to_le_bytes()` and the off-chain
        // `Buffer.writeBigUInt64LE` rely on this being 8.
        assert_eq!(INVOICE_INDEX_SEED_LEN, 0u64.to_le_bytes().len());
    }
}
