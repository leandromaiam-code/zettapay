//! Program-level error codes.
//!
//! Mapped to `ProgramError::Custom(u32)` at the entrypoint boundary. The
//! integer value of each variant is its position in this enum — adding,
//! removing, or reordering variants shifts those values and changes the
//! wire contract any off-chain decoder is built against. Append new
//! variants at the bottom only.

use solana_program::program_error::ProgramError;
use thiserror::Error;

#[derive(Error, Debug, Copy, Clone)]
pub enum ZpError {
    #[error("Invalid instruction discriminator or payload")]
    InvalidInstruction,
    #[error("Master signer does not match master_pubkey")]
    MasterMismatch,
    #[error("Merchant PDA does not match seeds")]
    MerchantPdaMismatch,
    #[error("Invoice PDA does not match seeds")]
    InvoicePdaMismatch,
    #[error("Chains list must be non-empty")]
    ChainsEmpty,
    #[error("Chains list exceeds MAX_CHAINS")]
    ChainsTooLong,
    #[error("Solana chain required in V1 (premise 1)")]
    SolanaChainRequired,
    #[error("Unknown chain tag")]
    UnknownChain,
    #[error("Currency not supported in V1 (premise 2: USDC only)")]
    CurrencyUnsupported,
    #[error("Amount must be greater than zero")]
    AmountZero,
    #[error("Account is not a Merchant")]
    NotMerchantAccount,
    #[error("Account is not an Invoice")]
    NotInvoiceAccount,
    #[error("Invoice does not belong to this merchant")]
    InvoiceMerchantMismatch,
    #[error("Invoice is not in Open status")]
    InvoiceNotOpen,
    #[error("Invoice index list must be non-empty")]
    NoInvoices,
    #[error("Account count does not match invoice index count")]
    AccountInvoiceCountMismatch,
    #[error("Numeric overflow")]
    Overflow,
    // --- Z26.3: Bitcoin SPV verifier ---------------------------------
    // Variants appended at the bottom only. Reordering shifts every
    // downstream Custom(u32) code and breaks the wire contract.
    #[error("SPV proof PDA does not match seeds")]
    SpvProofPdaMismatch,
    #[error("SPV proof account already initialized")]
    SpvAlreadyInitialized,
    #[error("SPV proof is not in the expected status")]
    SpvWrongStatus,
    #[error("SPV proof does not belong to this invoice")]
    SpvInvoiceMismatch,
    #[error("SPV proof submitter does not match original")]
    SpvSubmitterMismatch,
    #[error("Bitcoin transaction data is empty")]
    BtcTxDataEmpty,
    #[error("Merkle proof path exceeds maximum depth")]
    MerkleProofTooLong,
    #[error("Computed merkle root does not match block header")]
    MerkleRootMismatch,
    #[error("Block header has invalid length or encoding")]
    BlockHeaderInvalid,
    #[error("Block header does not satisfy proof-of-work target")]
    PoWInsufficient,
    #[error("Invoice has already been settled")]
    InvoiceAlreadyPaid,
}

impl From<ZpError> for ProgramError {
    fn from(e: ZpError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_codes_distinct() {
        let a: ProgramError = ZpError::InvalidInstruction.into();
        let b: ProgramError = ZpError::MasterMismatch.into();
        assert_ne!(a, b);
    }

    #[test]
    fn discriminator_order_is_pinned() {
        // Off-chain decoders rely on these integer values. Reordering or
        // inserting variants shifts every downstream value silently —
        // pin a handful of anchors so the test trips first.
        assert_eq!(ZpError::InvalidInstruction as u32, 0);
        assert_eq!(ZpError::MasterMismatch as u32, 1);
        assert_eq!(ZpError::MerchantPdaMismatch as u32, 2);
        assert_eq!(ZpError::InvoicePdaMismatch as u32, 3);
        assert_eq!(ZpError::Overflow as u32, 16);
        // Z26.3 appended block — pin the first SPV variant and last to
        // catch accidental insertions in the middle.
        assert_eq!(ZpError::SpvProofPdaMismatch as u32, 17);
        assert_eq!(ZpError::InvoiceAlreadyPaid as u32, 27);
    }
}
