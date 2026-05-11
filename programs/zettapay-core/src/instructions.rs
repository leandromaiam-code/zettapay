//! Instruction discriminator + Borsh-encoded argument types.
//!
//! Dispatch is discriminator-based on the leading byte of
//! `instruction_data`:
//!
//!   0 = RegisterMerchant { master_pubkey, chains[] }
//!   1 = CreateInvoice    { amount, currency }
//!   2 = Sweep            { invoice_indexes[] }
//!
//! The remainder of `instruction_data` is the variant's Borsh payload,
//! deserialized in the handler.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::pubkey::Pubkey;

#[repr(u8)]
pub enum InstructionTag {
    RegisterMerchant = 0,
    CreateInvoice = 1,
    Sweep = 2,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{CHAIN_BASE, CHAIN_SOLANA, CURRENCY_USDC};

    #[test]
    fn instruction_discriminators_are_distinct() {
        assert_eq!(InstructionTag::RegisterMerchant as u8, 0);
        assert_eq!(InstructionTag::CreateInvoice as u8, 1);
        assert_eq!(InstructionTag::Sweep as u8, 2);
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
}
