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

/// Seed prefix for the Bitcoin SPV payment proof PDA (Z26.3). Distinct
/// ASCII bytes ensure no collision with the `[master, invoice_index_le]`
/// invoice seeds — the prefix cannot be the first 8 bytes of any pubkey.
pub const SPV_PROOF_BTC_SEED: &[u8] = b"spv-btc";

/// Seed prefix for the Ethereum receipt-verifier proof PDA (Z26.4).
/// Distinct ASCII bytes ensure no collision with the BTC SPV proof PDA
/// or any other prefix — one ETH proof account per invoice, derived
/// independently of the BTC seed scheme so the same invoice can in
/// principle carry both proof types without one address shadowing the
/// other.
pub const SPV_PROOF_ETH_SEED: &[u8] = b"spv-eth";

/// Seed prefix for the singleton Bitcoin header chain PDA (Z26.5). One
/// account program-wide, no per-key suffix — the address is fully
/// determined by `(program_id, BTC_HEADER_CHAIN_SEED)`.
pub const BTC_HEADER_CHAIN_SEED: &[u8] = b"btc-header-chain";

/// Seed prefix for the singleton program-config PDA (Z30.1). One account
/// program-wide, no per-key suffix — the address is fully determined by
/// `(program_id, PROGRAM_CONFIG_SEED)`.
pub const PROGRAM_CONFIG_SEED: &[u8] = b"program-config";

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

/// Derive the Bitcoin SPV proof PDA for an invoice. One proof account
/// per invoice — the seed scheme rejects a second part_1 against the
/// same invoice through the `system_instruction::create_account`
/// already-allocated error.
pub fn find_spv_proof_btc_pda(invoice: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SPV_PROOF_BTC_SEED, invoice.as_ref()],
        program_id,
    )
}

/// Derive the Ethereum receipt-verifier proof PDA for an invoice (Z26.4).
/// Same one-account-per-invoice constraint as the BTC SPV proof — a
/// second part_1 against the same invoice would error on "already in
/// use" from the System Program inside `create_account`.
pub fn find_spv_proof_eth_pda(invoice: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[SPV_PROOF_ETH_SEED, invoice.as_ref()],
        program_id,
    )
}

/// Derive the singleton Bitcoin header chain PDA. Z26.5 — one account
/// program-wide. The address is fully determined by `(program_id,
/// BTC_HEADER_CHAIN_SEED)`, so the off-chain SDK can compute it without
/// any inputs from chain state.
pub fn find_btc_header_chain_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[BTC_HEADER_CHAIN_SEED], program_id)
}

/// Derive the singleton program-config PDA. Z30.1 — one account
/// program-wide. Holds the operator authority + the per-invoice USDC cap.
pub fn find_program_config_pda(program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[PROGRAM_CONFIG_SEED], program_id)
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
    fn spv_proof_btc_pda_is_deterministic_and_invoice_specific() {
        let program_id = fixed_program_id();
        let inv1 = Pubkey::new_from_array([21u8; 32]);
        let inv2 = Pubkey::new_from_array([22u8; 32]);
        let (a1, bump1) = find_spv_proof_btc_pda(&inv1, &program_id);
        let (a2, bump2) = find_spv_proof_btc_pda(&inv1, &program_id);
        let (b, _) = find_spv_proof_btc_pda(&inv2, &program_id);
        assert_eq!(a1, a2);
        assert_eq!(bump1, bump2);
        assert_ne!(a1, b);
    }

    #[test]
    fn spv_proof_btc_seed_cannot_collide_with_other_prefixes() {
        // The `b"spv-btc"` ASCII bytes cannot be the first 7 bytes of any
        // Solana pubkey (which is what would be needed to collide with
        // `[master, invoice_index_le]` invoice seeds or `[b"merchant",
        // master]` merchant seeds). Spot-check explicit collisions.
        let program_id = fixed_program_id();
        let inv = Pubkey::new_from_array([23u8; 32]);
        let (spv_pda, _) = find_spv_proof_btc_pda(&inv, &program_id);
        let (merchant_pda, _) = find_merchant_pda(&inv, &program_id);
        let (invoice_pda, _) = find_invoice_pda(&inv, 0, &program_id);
        assert_ne!(spv_pda, merchant_pda);
        assert_ne!(spv_pda, invoice_pda);
    }

    #[test]
    fn spv_proof_eth_pda_is_deterministic_and_invoice_specific() {
        let program_id = fixed_program_id();
        let inv1 = Pubkey::new_from_array([31u8; 32]);
        let inv2 = Pubkey::new_from_array([32u8; 32]);
        let (a1, bump1) = find_spv_proof_eth_pda(&inv1, &program_id);
        let (a2, bump2) = find_spv_proof_eth_pda(&inv1, &program_id);
        let (b, _) = find_spv_proof_eth_pda(&inv2, &program_id);
        assert_eq!(a1, a2);
        assert_eq!(bump1, bump2);
        assert_ne!(a1, b);
    }

    #[test]
    fn spv_proof_eth_seed_does_not_shadow_btc_proof_for_same_invoice() {
        // Same invoice key, different prefix bytes → different PDAs.
        // A bug that reused the BTC seed for the ETH PDA would let
        // either chain's finalize close the other's open proof.
        let program_id = fixed_program_id();
        let inv = Pubkey::new_from_array([41u8; 32]);
        let (btc_pda, _) = find_spv_proof_btc_pda(&inv, &program_id);
        let (eth_pda, _) = find_spv_proof_eth_pda(&inv, &program_id);
        assert_ne!(btc_pda, eth_pda);
    }

    #[test]
    fn btc_header_chain_pda_is_singleton_and_deterministic() {
        // No per-key suffix — every call with the same program id must
        // return the same address. Off-chain SDKs depend on this being
        // a single global pubkey across the program's lifetime.
        let program_id = fixed_program_id();
        let (a, bump_a) = find_btc_header_chain_pda(&program_id);
        let (b, bump_b) = find_btc_header_chain_pda(&program_id);
        assert_eq!(a, b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn btc_header_chain_pda_changes_per_program_id() {
        // Different deployments (devnet vs mainnet) get different PDAs.
        let p1 = Pubkey::new_from_array([42u8; 32]);
        let p2 = Pubkey::new_from_array([43u8; 32]);
        let (a, _) = find_btc_header_chain_pda(&p1);
        let (b, _) = find_btc_header_chain_pda(&p2);
        assert_ne!(a, b);
    }

    #[test]
    fn btc_header_chain_seed_cannot_collide_with_other_prefixes() {
        let program_id = fixed_program_id();
        let inv = Pubkey::new_from_array([23u8; 32]);
        let (chain_pda, _) = find_btc_header_chain_pda(&program_id);
        let (merchant_pda, _) = find_merchant_pda(&inv, &program_id);
        let (invoice_pda, _) = find_invoice_pda(&inv, 0, &program_id);
        let (spv_pda, _) = find_spv_proof_btc_pda(&inv, &program_id);
        assert_ne!(chain_pda, merchant_pda);
        assert_ne!(chain_pda, invoice_pda);
        assert_ne!(chain_pda, spv_pda);
    }

    #[test]
    fn program_config_pda_is_singleton_and_deterministic() {
        let program_id = fixed_program_id();
        let (a, bump_a) = find_program_config_pda(&program_id);
        let (b, bump_b) = find_program_config_pda(&program_id);
        assert_eq!(a, b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn program_config_pda_changes_per_program_id() {
        let p1 = Pubkey::new_from_array([42u8; 32]);
        let p2 = Pubkey::new_from_array([43u8; 32]);
        let (a, _) = find_program_config_pda(&p1);
        let (b, _) = find_program_config_pda(&p2);
        assert_ne!(a, b);
    }

    #[test]
    fn program_config_seed_cannot_collide_with_other_prefixes() {
        let program_id = fixed_program_id();
        let inv = Pubkey::new_from_array([23u8; 32]);
        let (cfg_pda, _) = find_program_config_pda(&program_id);
        let (merchant_pda, _) = find_merchant_pda(&inv, &program_id);
        let (invoice_pda, _) = find_invoice_pda(&inv, 0, &program_id);
        let (spv_pda, _) = find_spv_proof_btc_pda(&inv, &program_id);
        let (chain_pda, _) = find_btc_header_chain_pda(&program_id);
        assert_ne!(cfg_pda, merchant_pda);
        assert_ne!(cfg_pda, invoice_pda);
        assert_ne!(cfg_pda, spv_pda);
        assert_ne!(cfg_pda, chain_pda);
    }

    #[test]
    fn invoice_index_seed_len_matches_u64_width() {
        // INVOICE_INDEX_SEED_LEN must equal mem::size_of::<u64>(). Both
        // the on-chain `idx.to_le_bytes()` and the off-chain
        // `Buffer.writeBigUInt64LE` rely on this being 8.
        assert_eq!(INVOICE_INDEX_SEED_LEN, 0u64.to_le_bytes().len());
    }
}
