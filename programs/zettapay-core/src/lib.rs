//! ZettaPay Core — native Solana program (no Anchor).
//!
//! Three instructions, discriminator-based dispatch on the leading byte of
//! `instruction_data`:
//!
//!   0 = RegisterMerchant { master_pubkey, chains[] }
//!   1 = CreateInvoice    { amount, currency }
//!   2 = Sweep            { invoice_indexes[] }
//!
//! State accounts (PDAs):
//!
//!   Merchant: seeds = [b"merchant", master_pubkey]
//!   Invoice:  seeds = [master_pubkey, invoice_index_le]
//!
//! Invoice seeds intentionally match `deriveInvoicePda` in
//! `packages/sdk/src/onchain.ts` (Z26.1) so the off-chain SDK can predict
//! an invoice's address — and therefore its USDC ATA — without first
//! resolving the merchant PDA. Drift here silently breaks the SDK.
//!
//! Premise alignment:
//!   1. Solana-only V1 → RegisterMerchant requires `CHAIN_SOLANA` in chains
//!   2. USDC-only V1   → CreateInvoice rejects `currency != CURRENCY_USDC`
//!  14. No custody     → Sweep flips status only; it never moves USDC

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    system_program,
    sysvar::Sysvar,
};
use thiserror::Error;

// Placeholder program id. The on-chain key is established at `solana program
// deploy` time and is independent of this compile-time constant. Replace
// before mainnet (Z21/Z22 launch checklist).
solana_program::declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MERCHANT_SEED: &[u8] = b"merchant";

// Account type tags. First byte of every owned account so a wrong-type
// account passed to an instruction can be rejected without Anchor's 8-byte
// discriminator.
pub const MERCHANT_TAG: u8 = 1;
pub const INVOICE_TAG: u8 = 2;

// Currency tags. Premise 2 keeps V1 USDC-only; reserve the byte so adding
// stablecoins in Z11 doesn't force an account-layout migration.
pub const CURRENCY_USDC: u8 = 0;

// Chain tags. Premise 1 keeps V1 Solana-only; we still record the merchant's
// declared chain set so the off-chain index can route Z11 multi-chain
// settlement without re-registering.
pub const CHAIN_SOLANA: u8 = 0;
pub const CHAIN_ETHEREUM: u8 = 1;
pub const CHAIN_BASE: u8 = 2;
pub const CHAIN_POLYGON: u8 = 3;
pub const CHAIN_ARBITRUM: u8 = 4;
pub const CHAIN_AVALANCHE: u8 = 5;

pub const INVOICE_STATUS_OPEN: u8 = 0;
pub const INVOICE_STATUS_SWEPT: u8 = 1;

// Bound the chains list so the merchant PDA size is fixed at registration.
pub const MAX_CHAINS: usize = 16;

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

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Merchant {
    pub tag: u8,
    pub bump: u8,
    pub master_pubkey: Pubkey,
    pub chains: Vec<u8>,
    pub invoice_count: u64,
    pub registered_at: i64,
}

impl Merchant {
    pub const SIZE: usize = 1     // tag
        + 1                       // bump
        + 32                      // master_pubkey
        + 4 + MAX_CHAINS          // borsh Vec<u8>: u32 len + bytes
        + 8                       // invoice_count
        + 8;                      // registered_at
}

#[derive(BorshSerialize, BorshDeserialize, Debug)]
pub struct Invoice {
    pub tag: u8,
    pub bump: u8,
    pub merchant: Pubkey,
    pub invoice_index: u64,
    pub amount: u64,
    pub currency: u8,
    pub status: u8,
    pub created_at: i64,
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
}

impl From<ZpError> for ProgramError {
    fn from(e: ZpError) -> Self {
        ProgramError::Custom(e as u32)
    }
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let (tag, payload) = instruction_data
        .split_first()
        .ok_or(ZpError::InvalidInstruction)?;

    match *tag {
        0 => process_register_merchant(program_id, accounts, payload),
        1 => process_create_invoice(program_id, accounts, payload),
        2 => process_sweep(program_id, accounts, payload),
        _ => Err(ZpError::InvalidInstruction.into()),
    }
}

fn process_register_merchant(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = RegisterMerchantArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.chains.is_empty() {
        return Err(ZpError::ChainsEmpty.into());
    }
    if args.chains.len() > MAX_CHAINS {
        return Err(ZpError::ChainsTooLong.into());
    }
    if !args.chains.contains(&CHAIN_SOLANA) {
        return Err(ZpError::SolanaChainRequired.into());
    }
    for c in &args.chains {
        match *c {
            CHAIN_SOLANA | CHAIN_ETHEREUM | CHAIN_BASE | CHAIN_POLYGON
            | CHAIN_ARBITRUM | CHAIN_AVALANCHE => {}
            _ => return Err(ZpError::UnknownChain.into()),
        }
    }

    let iter = &mut accounts.iter();
    let merchant_ai = next_account_info(iter)?;
    let master_ai = next_account_info(iter)?;
    let payer_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    if !master_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if master_ai.key != &args.master_pubkey {
        return Err(ZpError::MasterMismatch.into());
    }
    if !payer_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_ai.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[MERCHANT_SEED, args.master_pubkey.as_ref()],
        program_id,
    );
    if merchant_ai.key != &expected_pda {
        return Err(ZpError::MerchantPdaMismatch.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(Merchant::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            merchant_ai.key,
            lamports,
            Merchant::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), merchant_ai.clone(), system_ai.clone()],
        &[&[MERCHANT_SEED, args.master_pubkey.as_ref(), &[bump]]],
    )?;

    let merchant = Merchant {
        tag: MERCHANT_TAG,
        bump,
        master_pubkey: args.master_pubkey,
        chains: args.chains,
        invoice_count: 0,
        registered_at: Clock::get()?.unix_timestamp,
    };
    merchant.serialize(&mut &mut merchant_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: merchant registered");
    Ok(())
}

fn process_create_invoice(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = CreateInvoiceArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.amount == 0 {
        return Err(ZpError::AmountZero.into());
    }
    if args.currency != CURRENCY_USDC {
        return Err(ZpError::CurrencyUnsupported.into());
    }

    let iter = &mut accounts.iter();
    let merchant_ai = next_account_info(iter)?;
    let master_ai = next_account_info(iter)?;
    let invoice_ai = next_account_info(iter)?;
    let payer_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    if merchant_ai.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if !master_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if !payer_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if system_ai.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut merchant = Merchant::try_from_slice(&merchant_ai.data.borrow())
        .map_err(|_| ZpError::NotMerchantAccount)?;
    if merchant.tag != MERCHANT_TAG {
        return Err(ZpError::NotMerchantAccount.into());
    }
    if merchant.master_pubkey != *master_ai.key {
        return Err(ZpError::MasterMismatch.into());
    }

    let invoice_index = merchant.invoice_count;

    let (expected_pda, bump) = Pubkey::find_program_address(
        &[
            master_ai.key.as_ref(),
            &invoice_index.to_le_bytes(),
        ],
        program_id,
    );
    if invoice_ai.key != &expected_pda {
        return Err(ZpError::InvoicePdaMismatch.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(Invoice::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            invoice_ai.key,
            lamports,
            Invoice::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), invoice_ai.clone(), system_ai.clone()],
        &[&[
            master_ai.key.as_ref(),
            &invoice_index.to_le_bytes(),
            &[bump],
        ]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let invoice = Invoice {
        tag: INVOICE_TAG,
        bump,
        merchant: *merchant_ai.key,
        invoice_index,
        amount: args.amount,
        currency: args.currency,
        status: INVOICE_STATUS_OPEN,
        created_at: now,
        swept_at: 0,
    };
    invoice.serialize(&mut &mut invoice_ai.data.borrow_mut()[..])?;

    merchant.invoice_count = merchant
        .invoice_count
        .checked_add(1)
        .ok_or(ZpError::Overflow)?;
    merchant.serialize(&mut &mut merchant_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: invoice created");
    Ok(())
}

fn process_sweep(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SweepArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.invoice_indexes.is_empty() {
        return Err(ZpError::NoInvoices.into());
    }

    let iter = &mut accounts.iter();
    let merchant_ai = next_account_info(iter)?;
    let master_ai = next_account_info(iter)?;

    if merchant_ai.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    if !master_ai.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let merchant = Merchant::try_from_slice(&merchant_ai.data.borrow())
        .map_err(|_| ZpError::NotMerchantAccount)?;
    if merchant.tag != MERCHANT_TAG {
        return Err(ZpError::NotMerchantAccount.into());
    }
    if merchant.master_pubkey != *master_ai.key {
        return Err(ZpError::MasterMismatch.into());
    }

    let now = Clock::get()?.unix_timestamp;

    // One invoice account per index, in the same order, after the merchant +
    // master pair. Mismatched lengths are a caller bug, not a silent skip.
    let invoice_accounts: Vec<&AccountInfo> = iter.collect();
    if invoice_accounts.len() != args.invoice_indexes.len() {
        return Err(ZpError::AccountInvoiceCountMismatch.into());
    }

    for (invoice_ai, idx) in invoice_accounts.iter().zip(args.invoice_indexes.iter()) {
        if invoice_ai.owner != program_id {
            return Err(ProgramError::IllegalOwner);
        }

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[master_ai.key.as_ref(), &idx.to_le_bytes()],
            program_id,
        );
        if invoice_ai.key != &expected_pda {
            return Err(ZpError::InvoicePdaMismatch.into());
        }

        let mut invoice = Invoice::try_from_slice(&invoice_ai.data.borrow())
            .map_err(|_| ZpError::NotInvoiceAccount)?;
        if invoice.tag != INVOICE_TAG {
            return Err(ZpError::NotInvoiceAccount.into());
        }
        if invoice.merchant != *merchant_ai.key {
            return Err(ZpError::InvoiceMerchantMismatch.into());
        }
        if invoice.status != INVOICE_STATUS_OPEN {
            return Err(ZpError::InvoiceNotOpen.into());
        }

        invoice.status = INVOICE_STATUS_SWEPT;
        invoice.swept_at = now;
        invoice.serialize(&mut &mut invoice_ai.data.borrow_mut()[..])?;
    }

    msg!("zettapay-core: invoices swept");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merchant_size_within_pda_max() {
        assert!(Merchant::SIZE < 10_240);
    }

    #[test]
    fn invoice_size_within_pda_max() {
        assert!(Invoice::SIZE < 10_240);
    }

    #[test]
    fn merchant_size_layout() {
        assert_eq!(Merchant::SIZE, 1 + 1 + 32 + (4 + MAX_CHAINS) + 8 + 8);
    }

    #[test]
    fn invoice_size_layout() {
        assert_eq!(Invoice::SIZE, 1 + 1 + 32 + 8 + 8 + 1 + 1 + 8 + 8);
    }

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

    #[test]
    fn merchant_state_roundtrip() {
        let m = Merchant {
            tag: MERCHANT_TAG,
            bump: 254,
            master_pubkey: Pubkey::new_from_array([3u8; 32]),
            chains: vec![CHAIN_SOLANA],
            invoice_count: 7,
            registered_at: 1_700_000_000,
        };
        let bytes = BorshSerialize::try_to_vec(&m).unwrap();
        let decoded = Merchant::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.tag, m.tag);
        assert_eq!(decoded.bump, m.bump);
        assert_eq!(decoded.master_pubkey, m.master_pubkey);
        assert_eq!(decoded.chains, m.chains);
        assert_eq!(decoded.invoice_count, m.invoice_count);
        assert_eq!(decoded.registered_at, m.registered_at);
    }

    #[test]
    fn invoice_state_roundtrip() {
        let inv = Invoice {
            tag: INVOICE_TAG,
            bump: 253,
            merchant: Pubkey::new_from_array([9u8; 32]),
            invoice_index: 41,
            amount: 5_000_000,
            currency: CURRENCY_USDC,
            status: INVOICE_STATUS_OPEN,
            created_at: 1_700_000_000,
            swept_at: 0,
        };
        let bytes = BorshSerialize::try_to_vec(&inv).unwrap();
        let decoded = Invoice::try_from_slice(&bytes).unwrap();
        assert_eq!(decoded.invoice_index, inv.invoice_index);
        assert_eq!(decoded.amount, inv.amount);
        assert_eq!(decoded.status, inv.status);
    }

    #[test]
    fn error_codes_distinct() {
        let a: ProgramError = ZpError::InvalidInstruction.into();
        let b: ProgramError = ZpError::MasterMismatch.into();
        assert_ne!(a, b);
    }
}
