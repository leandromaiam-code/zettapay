//! On-chain account state — manual Borsh, no `#[account]` macro.
//!
//! Each owned account begins with a single-byte `tag` so a wrong-type
//! account passed to an instruction is rejected with one equality check
//! before any deserialization side effect is observable. This is the
//! defensive role Anchor's 8-byte discriminator plays, at 1/8th the rent.
//!
//! Layouts are fixed-size so `Account::SIZE` can be passed verbatim to
//! `system_instruction::create_account`. Borsh's `Vec<u8>` length prefix
//! is accounted for via a hard cap (`MAX_CHAINS`).

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

// Account type tags. First byte of every owned account.
pub const MERCHANT_TAG: u8 = 1;
pub const INVOICE_TAG: u8 = 2;

// Currency tags. Premise 2 keeps V1 USDC-only; the tag byte exists so Z11
// can add stablecoins without an account-layout migration.
pub const CURRENCY_USDC: u8 = 0;

// Chain tags. Premise 1 keeps V1 Solana-only; the registered chain set is
// still recorded so the off-chain index can route Z11 multi-chain
// settlement without forcing merchants to re-register.
pub const CHAIN_SOLANA: u8 = 0;
pub const CHAIN_ETHEREUM: u8 = 1;
pub const CHAIN_BASE: u8 = 2;
pub const CHAIN_POLYGON: u8 = 3;
pub const CHAIN_ARBITRUM: u8 = 4;
pub const CHAIN_AVALANCHE: u8 = 5;

pub const INVOICE_STATUS_OPEN: u8 = 0;
pub const INVOICE_STATUS_SWEPT: u8 = 1;

/// Cap on the merchant's declared chain set. Bounding this fixes the
/// merchant PDA size at registration time so rent calculations are stable.
pub const MAX_CHAINS: usize = 16;

/// Merchant identity PDA. Seeds: see [`crate::pda::find_merchant_pda`].
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Merchant {
    pub tag: u8,
    pub bump: u8,
    pub master_pubkey: Pubkey,
    pub chains: Vec<u8>,
    /// Monotonic invoice counter. Becomes the `invoice_index` seed of the
    /// next invoice PDA — never decremented, never reused.
    pub invoice_count: u64,
    pub registered_at: i64,
}

impl Merchant {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // master_pubkey
        + 4 + MAX_CHAINS          // borsh Vec<u8>: u32 length prefix + bytes
        + 8                       // invoice_count
        + 8;                      // registered_at
}

/// Invoice receipt PDA. Seeds: see [`crate::pda::find_invoice_pda`].
#[derive(BorshSerialize, BorshDeserialize, Debug, Clone, PartialEq, Eq)]
pub struct Invoice {
    pub tag: u8,
    pub bump: u8,
    pub merchant: Pubkey,
    pub invoice_index: u64,
    /// USDC base units (6 decimals). Must be > 0.
    pub amount: u64,
    pub currency: u8,
    pub status: u8,
    pub created_at: i64,
    /// 0 while `status == INVOICE_STATUS_OPEN`. Set at sweep time.
    pub swept_at: i64,
}

impl Invoice {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // merchant
        + 8                       // invoice_index
        + 8                       // amount
        + 1                       // currency
        + 1                       // status
        + 8                       // created_at
        + 8;                      // swept_at
}

#[cfg(test)]
mod tests {
    use super::*;
    use borsh::BorshSerialize as _;

    #[test]
    fn merchant_size_within_pda_max() {
        assert!(Merchant::SIZE < 10_240);
    }

    #[test]
    fn invoice_size_within_pda_max() {
        assert!(Invoice::SIZE < 10_240);
    }

    #[test]
    fn merchant_size_matches_field_layout() {
        assert_eq!(Merchant::SIZE, 1 + 1 + 32 + (4 + MAX_CHAINS) + 8 + 8);
    }

    #[test]
    fn invoice_size_matches_field_layout() {
        assert_eq!(Invoice::SIZE, 1 + 1 + 32 + 8 + 8 + 1 + 1 + 8 + 8);
    }

    #[test]
    fn merchant_roundtrip_via_borsh() {
        let m = Merchant {
            tag: MERCHANT_TAG,
            bump: 254,
            master_pubkey: Pubkey::new_from_array([7u8; 32]),
            chains: vec![CHAIN_SOLANA, CHAIN_BASE, CHAIN_POLYGON],
            invoice_count: 41,
            registered_at: 1_700_000_000,
        };
        let bytes = m.try_to_vec().unwrap();
        let decoded = Merchant::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, m);
    }

    #[test]
    fn invoice_roundtrip_via_borsh() {
        let inv = Invoice {
            tag: INVOICE_TAG,
            bump: 253,
            merchant: Pubkey::new_from_array([3u8; 32]),
            invoice_index: 9,
            amount: 5_000_000,
            currency: CURRENCY_USDC,
            status: INVOICE_STATUS_OPEN,
            created_at: 1_700_000_001,
            swept_at: 0,
        };
        let bytes = inv.try_to_vec().unwrap();
        let decoded = Invoice::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded, inv);
    }

    #[test]
    fn merchant_borsh_length_matches_fixed_size_when_chains_full() {
        // The fixed `Merchant::SIZE` must hold the serialized form when
        // the chain set is at MAX_CHAINS. If the two diverge, a
        // fully-loaded merchant would overflow the allocated account
        // data. This test fails before that ships.
        let m = Merchant {
            tag: MERCHANT_TAG,
            bump: 0,
            master_pubkey: Pubkey::default(),
            chains: vec![CHAIN_SOLANA; MAX_CHAINS],
            invoice_count: 0,
            registered_at: 0,
        };
        let bytes = m.try_to_vec().unwrap();
        assert_eq!(bytes.len(), Merchant::SIZE);
    }

    #[test]
    fn invoice_borsh_length_matches_fixed_size() {
        let inv = Invoice {
            tag: INVOICE_TAG,
            bump: 0,
            merchant: Pubkey::default(),
            invoice_index: 0,
            amount: 0,
            currency: CURRENCY_USDC,
            status: INVOICE_STATUS_OPEN,
            created_at: 0,
            swept_at: 0,
        };
        let bytes = inv.try_to_vec().unwrap();
        assert_eq!(bytes.len(), Invoice::SIZE);
    }
}
