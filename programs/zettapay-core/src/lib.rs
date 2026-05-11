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
//! Module map (Z25.2 refactor):
//!
//!   * `state`        — Merchant + Invoice structs, manual Borsh,
//!                      fixed account sizes, tag/status/currency/chain
//!                      constants.
//!   * `pda`          — Merchant + Invoice PDA derivation.
//!   * `validation`   — Manual owner / signer / system-program / tag
//!                      assertions replacing what Anchor's `#[account]`
//!                      macro would generate.
//!   * `instructions` — `InstructionTag` discriminator + Borsh-encoded
//!                      argument types per variant.
//!   * `error`        — `ZpError` mapped to `ProgramError::Custom(u32)`.
//!
//! Premise alignment:
//!   1. Solana-only V1 → RegisterMerchant requires `CHAIN_SOLANA` in chains
//!   2. USDC-only V1   → CreateInvoice rejects `currency != CURRENCY_USDC`
//!  14. No custody     → Sweep flips status only; it never moves USDC

#![allow(clippy::result_large_err)]

pub mod error;
pub mod instructions;
pub mod pda;
pub mod state;
pub mod validation;

// Crate-root re-exports preserve the public surface from before the Z25.2
// modular split — existing callers that did
// `use zettapay_core::{Merchant, MERCHANT_SEED, ZpError, ...}` resolve
// unchanged.
pub use error::ZpError;
pub use instructions::{CreateInvoiceArgs, InstructionTag, RegisterMerchantArgs, SweepArgs};
pub use pda::{find_invoice_pda, find_merchant_pda, INVOICE_INDEX_SEED_LEN, MERCHANT_SEED};
pub use state::{
    Invoice, Merchant, CHAIN_ARBITRUM, CHAIN_AVALANCHE, CHAIN_BASE, CHAIN_ETHEREUM, CHAIN_POLYGON,
    CHAIN_SOLANA, CURRENCY_USDC, INVOICE_STATUS_OPEN, INVOICE_STATUS_SWEPT, INVOICE_TAG,
    MAX_CHAINS, MERCHANT_TAG,
};
pub use validation::{assert_owned_by_program, assert_signer, assert_system_program, assert_tag};

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program::invoke_signed,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};

// Placeholder program id. The on-chain key is established at `solana program
// deploy` time and is independent of this compile-time constant. Replace
// before mainnet (Z21/Z22 launch checklist).
solana_program::declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

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

    assert_signer(master_ai)?;
    if master_ai.key != &args.master_pubkey {
        return Err(ZpError::MasterMismatch.into());
    }
    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    let (expected_pda, bump) = find_merchant_pda(&args.master_pubkey, program_id);
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

    assert_owned_by_program(merchant_ai, program_id)?;
    assert_signer(master_ai)?;
    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    let mut merchant = Merchant::try_from_slice(&merchant_ai.data.borrow())
        .map_err(|_| ZpError::NotMerchantAccount)?;
    if merchant.tag != MERCHANT_TAG {
        return Err(ZpError::NotMerchantAccount.into());
    }
    if merchant.master_pubkey != *master_ai.key {
        return Err(ZpError::MasterMismatch.into());
    }

    let invoice_index = merchant.invoice_count;

    let (expected_pda, bump) = find_invoice_pda(master_ai.key, invoice_index, program_id);
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

    assert_owned_by_program(merchant_ai, program_id)?;
    assert_signer(master_ai)?;

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
        assert_owned_by_program(invoice_ai, program_id)?;

        let (expected_pda, _bump) = find_invoice_pda(master_ai.key, *idx, program_id);
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
mod integration_tests {
    //! Cross-module sanity checks. Per-module unit tests live next to the
    //! code they cover; this module is reserved for invariants that span
    //! more than one of `state`, `pda`, or `validation`.

    use super::*;

    #[test]
    fn merchant_pda_seeds_match_module_constant() {
        // The dispatcher signs `create_account` with seeds reconstructed
        // from `MERCHANT_SEED` and the master pubkey. If `MERCHANT_SEED`
        // drifts from what `find_merchant_pda` uses internally, the
        // signed seeds won't match the discovered PDA and `invoke_signed`
        // will fail at run-time. Pin them here.
        let master = Pubkey::new_from_array([7u8; 32]);
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let (a, _) = find_merchant_pda(&master, &program_id);
        let (b, _) = Pubkey::find_program_address(
            &[MERCHANT_SEED, master.as_ref()],
            &program_id,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn invoice_pda_seeds_match_le_u64_encoding() {
        // Same drift guard for the invoice PDA: the dispatcher signs
        // `create_account` with `idx.to_le_bytes()`, which must agree
        // with `find_invoice_pda`'s internal seed construction.
        let master = Pubkey::new_from_array([7u8; 32]);
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let idx: u64 = 17;
        let (a, _) = find_invoice_pda(&master, idx, &program_id);
        let (b, _) = Pubkey::find_program_address(
            &[master.as_ref(), &idx.to_le_bytes()],
            &program_id,
        );
        assert_eq!(a, b);
    }
}
