//! Instruction discriminator + Borsh-encoded argument types.
//!
//! Dispatch is discriminator-based on the leading byte of
//! `instruction_data`:
//!
//!   0 = RegisterMerchant     { master_pubkey, chains[] }
//!   1 = CreateInvoice        { amount, currency }
//!   2 = Sweep                { invoice_indexes[] }
//!   3 = SubmitBtcProofPart1  { tx_data, merkle_path[], merkle_index }
//!   4 = SubmitBtcProofPart2  { block_header (80 bytes) }
//!   5 = FinalizeBtcPayment   {}
//!   6 = InitBtcHeaderChain   { anchor_header (80 bytes), anchor_height }
//!   7 = UpdateBtcHeader      { new_header (80 bytes) }
//!
//! The remainder of `instruction_data` is the variant's Borsh payload,
//! deserialized in the handler.
//!
//! The three SPV variants split a single Bitcoin payment proof into
//! three transactions so each one stays inside Solana's per-instruction
//! compute-unit budget (~200k CU): merkle inclusion in part 1, PoW
//! validation in part 2, invoice settlement in finalize.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[repr(u8)]
pub enum InstructionTag {
    RegisterMerchant = 0,
    CreateInvoice = 1,
    Sweep = 2,
    SubmitBtcProofPart1 = 3,
    SubmitBtcProofPart2 = 4,
    FinalizeBtcPayment = 5,
    InitBtcHeaderChain = 6,
    UpdateBtcHeader = 7,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct RegisterMerchantArgs {
    pub master_pubkey: Pubkey,
    pub chains: Vec<u8>,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct CreateInvoiceArgs {
    pub amount: u64,
    pub currency: u8,
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SweepArgs {
    pub invoice_indexes: Vec<u64>,
}

/// Arguments for `submit_btc_proof_part_1`.
///
/// `tx_data` is the serialized Bitcoin transaction in wire format; the
/// program double-SHA256s it to derive the txid. `merkle_path` is the
/// authentication path from that txid up to the block's merkle root.
/// `merkle_index` is the leaf's position in the block — its low bits
/// drive the left/right ordering at each merkle level.
///
/// `tx_data` is deliberately not stored on-chain: only the committed
/// txid + merkle root carry forward, so the account size is bounded
/// regardless of how large a transaction the caller submitted.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SubmitBtcProofPart1Args {
    pub tx_data: Vec<u8>,
    pub merkle_path: Vec<[u8; 32]>,
    pub merkle_index: u32,
}

/// Arguments for `submit_btc_proof_part_2`.
///
/// `block_header` is the raw 80-byte Bitcoin block header that purports
/// to contain the part_1 transaction. We use `Vec<u8>` rather than
/// `[u8; 80]` because borsh 0.10 does not derive serializers for
/// arrays past `[T; 32]`. The length is enforced at run time so a
/// caller cannot smuggle a non-standard header.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SubmitBtcProofPart2Args {
    pub block_header: Vec<u8>,
}

/// Arguments for `finalize_btc_payment`. There are none: every value
/// finalisation needs is already on the SPV proof account, the matching
/// invoice account, and the merchant's master signature.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct FinalizeBtcPaymentArgs {}

/// Arguments for `init_btc_header_chain` (Z26.5).
///
/// One-time bootstrap of the singleton `BitcoinHeaderChain` account. The
/// caller supplies an anchor: the 80-byte block header that the rolling
/// window will be seeded from, plus its block height (advisory — Bitcoin
/// headers do not self-attest height). The anchor header is validated
/// for PoW before being written; without that check, init could seed
/// the chain with garbage that subsequent `update_btc_header` calls
/// would then trust.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct InitBtcHeaderChainArgs {
    pub anchor_header: Vec<u8>,
    pub anchor_height: u64,
}

/// Arguments for `update_btc_header` (Z26.5).
///
/// Advances the chain tip by one block. The caller supplies the next
/// 80-byte block header; the program validates it against the current
/// `latest_hash` (continuity) and the header's own `nBits` field (PoW)
/// before writing it into the ring buffer. The instruction is callable
/// by any wallet — replay protection comes for free from the continuity
/// check, since the chain's `latest_hash` advances on every successful
/// update.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct UpdateBtcHeaderArgs {
    pub new_header: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{CHAIN_BASE, CHAIN_SOLANA, CURRENCY_USDC};

    #[test]
    fn instruction_discriminators_are_distinct() {
        assert_eq!(InstructionTag::RegisterMerchant as u8, 0);
        assert_eq!(InstructionTag::CreateInvoice as u8, 1);
        assert_eq!(InstructionTag::Sweep as u8, 2);
        assert_eq!(InstructionTag::SubmitBtcProofPart1 as u8, 3);
        assert_eq!(InstructionTag::SubmitBtcProofPart2 as u8, 4);
        assert_eq!(InstructionTag::FinalizeBtcPayment as u8, 5);
        assert_eq!(InstructionTag::InitBtcHeaderChain as u8, 6);
        assert_eq!(InstructionTag::UpdateBtcHeader as u8, 7);
    }

    #[test]
    fn register_merchant_args_roundtrip() {
        let args = RegisterMerchantArgs {
            master_pubkey: Pubkey::new_from_array([7u8; 32]),
            chains: vec![CHAIN_SOLANA, CHAIN_BASE],
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = RegisterMerchantArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.master_pubkey, args.master_pubkey);
        assert_eq!(decoded.chains, args.chains);
    }

    #[test]
    fn create_invoice_args_roundtrip() {
        let args = CreateInvoiceArgs {
            amount: 1_000_000,
            currency: CURRENCY_USDC,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = CreateInvoiceArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.amount, args.amount);
        assert_eq!(decoded.currency, args.currency);
    }

    #[test]
    fn sweep_args_roundtrip() {
        let args = SweepArgs {
            invoice_indexes: vec![0, 1, 2, 3, 42],
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SweepArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.invoice_indexes, args.invoice_indexes);
    }

    #[test]
    fn submit_btc_proof_part_1_args_roundtrip() {
        let args = SubmitBtcProofPart1Args {
            tx_data: vec![0x01, 0x02, 0x03, 0x04],
            merkle_path: vec![[7u8; 32], [8u8; 32], [9u8; 32]],
            merkle_index: 0b101,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SubmitBtcProofPart1Args::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.tx_data, args.tx_data);
        assert_eq!(decoded.merkle_path, args.merkle_path);
        assert_eq!(decoded.merkle_index, args.merkle_index);
    }

    #[test]
    fn submit_btc_proof_part_2_args_roundtrip() {
        let args = SubmitBtcProofPart2Args {
            block_header: vec![0xab; 80],
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SubmitBtcProofPart2Args::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.block_header, args.block_header);
    }

    #[test]
    fn finalize_btc_payment_args_roundtrip() {
        let args = FinalizeBtcPaymentArgs::default();
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        // No fields → zero-byte payload.
        assert!(bytes.is_empty());
        let _decoded = FinalizeBtcPaymentArgs::try_from_slice(&bytes).unwrap();
    }

    #[test]
    fn init_btc_header_chain_args_roundtrip() {
        let args = InitBtcHeaderChainArgs {
            anchor_header: vec![0xcd; 80],
            anchor_height: 850_000,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = InitBtcHeaderChainArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.anchor_header, args.anchor_header);
        assert_eq!(decoded.anchor_height, args.anchor_height);
    }

    #[test]
    fn update_btc_header_args_roundtrip() {
        let args = UpdateBtcHeaderArgs {
            new_header: vec![0xef; 80],
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = UpdateBtcHeaderArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.new_header, args.new_header);
    }
}
