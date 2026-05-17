//! Instruction discriminator + Borsh-encoded argument types.
//!
//! Dispatch is discriminator-based on the leading byte of
//! `instruction_data`:
//!
//!   0 = RegisterMerchant      { master_pubkey, chains[] }
//!   1 = CreateInvoice         { amount, currency }
//!   2 = Sweep                 { invoice_indexes[] }
//!   3 = SubmitBtcProofPart1   { tx_data, merkle_path[], merkle_index }
//!   4 = SubmitBtcProofPart2   { block_header (80 bytes) }
//!   5 = FinalizeBtcPayment    {}
//!   6 = InitBtcHeaderChain    { anchor_header (80 bytes), anchor_height }
//!   7 = UpdateBtcHeader       { new_header (80 bytes) }
//!   8 = InitProgramConfig     { max_invoice_amount }                   (Z30.1)
//!   9 = SetMaxInvoiceAmount   { max_invoice_amount }                   (Z30.1)
//!  10 = SubmitEthReceiptPart1 { token, from, to, amount,
//!                               merkle_path[], merkle_index }          (Z26.4)
//!  11 = SubmitEthReceiptPart2 { header_rlp, signature (65),
//!                               receipts_root_offset, signing_payload } (Z26.4)
//!  12 = FinalizeEthPayment    {}                                        (Z26.4)
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
    InitProgramConfig = 8,
    SetMaxInvoiceAmount = 9,
    SubmitEthReceiptPart1 = 10,
    SubmitEthReceiptPart2 = 11,
    FinalizeEthPayment = 12,
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

/// Arguments for `init_program_config` (Z30.1).
///
/// One-time bootstrap of the singleton `ProgramConfig` account. The
/// signer that pays for the init becomes the recorded `authority`; only
/// that signer can subsequently call `set_max_invoice_amount`. Beta
/// mainnet launches with `max_invoice_amount = 100_000_000` (100 USDC
/// at 6 decimals) — see `state::DEFAULT_MAX_INVOICE_AMOUNT`. The Sprint
/// Z30 cap-upgrade orchestrator (Z30.4 / Z30.5) raises the value
/// off-chain by re-broadcasting `set_max_invoice_amount`.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct InitProgramConfigArgs {
    pub max_invoice_amount: u64,
}

/// Arguments for `set_max_invoice_amount` (Z30.1).
///
/// Update the per-invoice USDC cap. Callable only by the authority
/// recorded at `init_program_config` time. A value of `0` disables cap
/// enforcement entirely (Z30.5 D+60 removal sentinel).
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SetMaxInvoiceAmountArgs {
    pub max_invoice_amount: u64,
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

/// Arguments for `submit_eth_receipt_part_1` (Z26.4).
///
/// Part_1 commits the parsed USDC Transfer (`token`, `from_addr`,
/// `to_addr`, `amount`) and folds a `receipt_hash` up the receipts-trie
/// authentication path into a `receipts_root`. The off-chain prover
/// flattens the Ethereum MPT branch nodes into a binary path the BPF
/// verifier can fold cheaply.
///
/// The on-chain `log_hash` is recomputed from the structured fields via
/// `ethspv::transfer_log_canonical_hash`, pinning the (token, from, to,
/// amount) tuple — finalize cannot be replayed against a different
/// Transfer because the part_1 commitment carries forward.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SubmitEthReceiptPart1Args {
    /// USDC ERC-20 contract address the Transfer was emitted from.
    pub token: [u8; 20],
    /// Transfer `from` (payer) — first indexed parameter.
    pub from_addr: [u8; 20],
    /// Transfer `to` (merchant) — second indexed parameter.
    pub to_addr: [u8; 20],
    /// Transfer `value` in USDC base units (6 decimals). Narrowed from
    /// the on-chain uint256 to u64.
    pub amount: u64,
    /// `keccak256` of the RLP-encoded receipt entry, computed off-chain.
    /// The verifier folds this through `merkle_path` into the receipts
    /// root; the off-chain commitment is what binds the Transfer log to
    /// the receipt.
    pub receipt_hash: [u8; 32],
    /// Authentication path of sibling node hashes, from the receipt's
    /// leaf up to the receipts root.
    pub merkle_path: Vec<[u8; 32]>,
    /// Receipt's flattened position in the receipts-trie path. The low
    /// bit at each level decides left/right ordering inside the merkle
    /// fold.
    pub merkle_index: u32,
}

/// Arguments for `submit_eth_receipt_part_2` (Z26.4).
///
/// Part_2 validates the supplied block header carries the
/// `receipts_root` computed in part_1, runs `secp256k1_recover` over
/// the seal signature, and records the recovered signer address and
/// the full-header block hash.
///
/// The caller supplies two header byte strings: `header_rlp` is the
/// raw RLP-encoded header (used for the block hash) and
/// `signing_payload` is the same header with the 65-byte seal stripped
/// from extraData (Clique convention). Both are required because the
/// on-chain verifier cannot afford to RLP-decode the header to extract
/// the seal — the off-chain prover does the slicing and the verifier
/// independently keccak256s each payload.
///
/// `receipts_root_offset` is the byte offset inside `header_rlp` at
/// which the 32-byte receipts_root field sits. The caller supplies the
/// offset because, again, the on-chain verifier does not RLP-decode the
/// header. The off-chain prover computes the offset deterministically
/// from the header's prefix; a forged offset would point at a
/// receipts_root that doesn't match part_1's commitment and the
/// verifier rejects it.
#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct SubmitEthReceiptPart2Args {
    /// Raw RLP-encoded block header bytes. Hashed in full to derive the
    /// `block_hash` stored on the proof account.
    pub header_rlp: Vec<u8>,
    /// Header bytes with the 65-byte seal stripped from extraData — the
    /// canonical Clique signing payload. `keccak256(signing_payload)`
    /// is the digest passed to `secp256k1_recover`.
    pub signing_payload: Vec<u8>,
    /// 65-byte seal signature in `r||s||v` layout.
    pub signature: Vec<u8>,
    /// Byte offset inside `header_rlp` where the 32-byte `receipts_root`
    /// field starts. Verified against part_1's committed root.
    pub receipts_root_offset: u32,
}

/// Arguments for `finalize_eth_payment` (Z26.4). Empty — every value
/// finalisation needs is already on the SPV proof account, the matching
/// invoice account, and the merchant's master signature.
#[derive(BorshSerialize, BorshDeserialize, Debug, Default)]
pub struct FinalizeEthPaymentArgs {}

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
        assert_eq!(InstructionTag::InitProgramConfig as u8, 8);
        assert_eq!(InstructionTag::SetMaxInvoiceAmount as u8, 9);
        assert_eq!(InstructionTag::SubmitEthReceiptPart1 as u8, 10);
        assert_eq!(InstructionTag::SubmitEthReceiptPart2 as u8, 11);
        assert_eq!(InstructionTag::FinalizeEthPayment as u8, 12);
    }

    #[test]
    fn init_program_config_args_roundtrip() {
        let args = InitProgramConfigArgs {
            max_invoice_amount: 100_000_000,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = InitProgramConfigArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.max_invoice_amount, args.max_invoice_amount);
    }

    #[test]
    fn set_max_invoice_amount_args_roundtrip() {
        let args = SetMaxInvoiceAmountArgs {
            max_invoice_amount: 500_000_000,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SetMaxInvoiceAmountArgs::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.max_invoice_amount, args.max_invoice_amount);
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

    #[test]
    fn submit_eth_receipt_part_1_args_roundtrip() {
        let args = SubmitEthReceiptPart1Args {
            token: [0x11u8; 20],
            from_addr: [0x22u8; 20],
            to_addr: [0x33u8; 20],
            amount: 1_500_000,
            receipt_hash: [0x44u8; 32],
            merkle_path: vec![[7u8; 32], [8u8; 32]],
            merkle_index: 0b10,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SubmitEthReceiptPart1Args::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.token, args.token);
        assert_eq!(decoded.from_addr, args.from_addr);
        assert_eq!(decoded.to_addr, args.to_addr);
        assert_eq!(decoded.amount, args.amount);
        assert_eq!(decoded.receipt_hash, args.receipt_hash);
        assert_eq!(decoded.merkle_path, args.merkle_path);
        assert_eq!(decoded.merkle_index, args.merkle_index);
    }

    #[test]
    fn submit_eth_receipt_part_2_args_roundtrip() {
        let args = SubmitEthReceiptPart2Args {
            header_rlp: vec![0xaa; 600],
            signing_payload: vec![0xbb; 535],
            signature: vec![0xcc; 65],
            receipts_root_offset: 187,
        };
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        let decoded = SubmitEthReceiptPart2Args::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.header_rlp, args.header_rlp);
        assert_eq!(decoded.signing_payload, args.signing_payload);
        assert_eq!(decoded.signature, args.signature);
        assert_eq!(decoded.receipts_root_offset, args.receipts_root_offset);
    }

    #[test]
    fn finalize_eth_payment_args_roundtrip() {
        let args = FinalizeEthPaymentArgs::default();
        let bytes = BorshSerialize::try_to_vec(&args).unwrap();
        // No fields → zero-byte payload, same as the BTC variant.
        assert!(bytes.is_empty());
        let _decoded = FinalizeEthPaymentArgs::try_from_slice(&bytes).unwrap();
    }
}
