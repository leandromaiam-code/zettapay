//! ZettaPay Core — native Solana program (no Anchor).
//!
//! Six instructions, discriminator-based dispatch on the leading byte of
//! `instruction_data`:
//!
//!   0 = RegisterMerchant     { master_pubkey, chains[] }
//!   1 = CreateInvoice        { amount, currency }
//!   2 = Sweep                { invoice_indexes[] }
//!   3 = SubmitBtcProofPart1  { tx_data, merkle_path, merkle_index } (Z26.3)
//!   4 = SubmitBtcProofPart2  { block_header (80 bytes) }            (Z26.3)
//!   5 = FinalizeBtcPayment   {}                                     (Z26.3)
//!
//! State accounts (PDAs):
//!
//!   Merchant:    seeds = [b"merchant", master_pubkey]
//!   Invoice:     seeds = [master_pubkey, invoice_index_le]
//!   SpvProofBtc: seeds = [b"spv-btc",  invoice_pubkey]              (Z26.3)
//!
//! Invoice seeds intentionally match `deriveInvoicePda` in
//! `packages/sdk/src/onchain.ts` (Z26.1) so the off-chain SDK can predict
//! an invoice's address — and therefore its USDC ATA — without first
//! resolving the merchant PDA. Drift here silently breaks the SDK.
//!
//! Module map (Z25.2 refactor, extended Z26.3):
//!
//!   * `state`        — Merchant + Invoice + SpvProofBtc structs,
//!                      manual Borsh, fixed account sizes,
//!                      tag/status/currency/chain constants.
//!   * `pda`          — Merchant + Invoice + SpvProofBtc PDA derivation.
//!   * `validation`   — Manual owner / signer / system-program / tag
//!                      assertions replacing what Anchor's `#[account]`
//!                      macro would generate.
//!   * `instructions` — `InstructionTag` discriminator + Borsh-encoded
//!                      argument types per variant.
//!   * `error`        — `ZpError` mapped to `ProgramError::Custom(u32)`.
//!   * `spv`          — Bitcoin SPV crypto primitives: SHA256d,
//!                      merkle-root folding, nBits → target,
//!                      PoW comparison.
//!
//! Premise alignment:
//!   1. Solana-only V1 → RegisterMerchant requires `CHAIN_SOLANA` in chains
//!   2. USDC-only V1   → CreateInvoice rejects `currency != CURRENCY_USDC`
//!  14. No custody     — Sweep and FinalizeBtcPayment flip invoice status
//!                       only; neither moves USDC on-chain. BTC settlement
//!                       happened on the Bitcoin chain; finalize records
//!                       cryptographic proof that it did.
//!
//! SPV verifier (Z26.3) is chunked across three transactions so each
//! one stays inside Solana's ~200k CU per-instruction budget: merkle
//! inclusion in part 1, PoW validation in part 2, invoice state flip
//! in finalize.

#![allow(clippy::result_large_err)]

pub mod error;
pub mod instructions;
pub mod pda;
pub mod spv;
pub mod state;
pub mod validation;

// Crate-root re-exports preserve the public surface from before the Z25.2
// modular split — existing callers that did
// `use zettapay_core::{Merchant, MERCHANT_SEED, ZpError, ...}` resolve
// unchanged.
pub use error::ZpError;
pub use instructions::{
    CreateInvoiceArgs, FinalizeBtcPaymentArgs, InstructionTag, RegisterMerchantArgs,
    SubmitBtcProofPart1Args, SubmitBtcProofPart2Args, SweepArgs,
};
pub use pda::{
    find_invoice_pda, find_merchant_pda, find_spv_proof_btc_pda, INVOICE_INDEX_SEED_LEN,
    MERCHANT_SEED, SPV_PROOF_BTC_SEED,
};
pub use spv::{
    compute_merkle_root_from_proof, hash_le_meets_target_le, header_merkle_root, header_n_bits,
    n_bits_to_target, sha256d, BLOCK_HEADER_LEN, MAX_MERKLE_PROOF_DEPTH,
};
pub use state::{
    Invoice, Merchant, SpvProofBtc, CHAIN_ARBITRUM, CHAIN_AVALANCHE, CHAIN_BASE, CHAIN_ETHEREUM,
    CHAIN_POLYGON, CHAIN_SOLANA, CURRENCY_USDC, INVOICE_STATUS_OPEN, INVOICE_STATUS_PAID_BTC,
    INVOICE_STATUS_SWEPT, INVOICE_TAG, MAX_CHAINS, MERCHANT_TAG, SPV_PROOF_BTC_TAG,
    SPV_STATUS_FINALIZED, SPV_STATUS_PART1_DONE, SPV_STATUS_PART2_DONE,
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
        3 => process_submit_btc_proof_part_1(program_id, accounts, payload),
        4 => process_submit_btc_proof_part_2(program_id, accounts, payload),
        5 => process_finalize_btc_payment(program_id, accounts, payload),
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

// --- Z26.3: Bitcoin SPV verifier --------------------------------------
//
// Three transactions per payment proof, each tagged 3 / 4 / 5:
//
//   part 1: hash tx_data into a txid, fold the merkle path, store the
//           commitments. Independent of any block header.
//   part 2: validate that the supplied 80-byte block header carries the
//           merkle root we computed and that its SHA256d satisfies the
//           difficulty target encoded in nBits. Store the block hash.
//   final:  flip the matching invoice to INVOICE_STATUS_PAID_BTC. The
//           merchant's master signs to acknowledge — there is no on-
//           chain USDC movement (premise 14: no custody).

fn process_submit_btc_proof_part_1(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SubmitBtcProofPart1Args::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.tx_data.is_empty() {
        return Err(ZpError::BtcTxDataEmpty.into());
    }
    if args.merkle_path.len() > spv::MAX_MERKLE_PROOF_DEPTH {
        return Err(ZpError::MerkleProofTooLong.into());
    }

    let iter = &mut accounts.iter();
    let spv_proof_ai = next_account_info(iter)?;
    let invoice_ai = next_account_info(iter)?;
    let submitter_ai = next_account_info(iter)?;
    let payer_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    assert_owned_by_program(invoice_ai, program_id)?;
    let invoice = Invoice::try_from_slice(&invoice_ai.data.borrow())
        .map_err(|_| ZpError::NotInvoiceAccount)?;
    if invoice.tag != INVOICE_TAG {
        return Err(ZpError::NotInvoiceAccount.into());
    }
    if invoice.status != INVOICE_STATUS_OPEN {
        return Err(ZpError::InvoiceAlreadyPaid.into());
    }

    assert_signer(submitter_ai)?;
    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    let (expected_pda, bump) = find_spv_proof_btc_pda(invoice_ai.key, program_id);
    if spv_proof_ai.key != &expected_pda {
        return Err(ZpError::SpvProofPdaMismatch.into());
    }
    // The SPV proof account must be brand new — system-owned with zero
    // data. A second part_1 against the same invoice would re-enter
    // here and `create_account` below would error on "already in use",
    // but pinning the precondition gives the precise SpvAlreadyInitialized
    // code instead of leaking the SystemProgram error.
    if spv_proof_ai.owner == program_id || !spv_proof_ai.data.borrow().is_empty() {
        return Err(ZpError::SpvAlreadyInitialized.into());
    }

    // Crypto first, allocation second — if the proof is forged we want
    // to fail before paying rent.
    let txid = spv::sha256d(&args.tx_data);
    let merkle_root = spv::compute_merkle_root_from_proof(
        txid,
        &args.merkle_path,
        args.merkle_index,
    );

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SpvProofBtc::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            spv_proof_ai.key,
            lamports,
            SpvProofBtc::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), spv_proof_ai.clone(), system_ai.clone()],
        &[&[SPV_PROOF_BTC_SEED, invoice_ai.key.as_ref(), &[bump]]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let proof = SpvProofBtc {
        tag: SPV_PROOF_BTC_TAG,
        bump,
        invoice: *invoice_ai.key,
        submitter: *submitter_ai.key,
        txid,
        merkle_root,
        block_hash: [0u8; 32],
        status: SPV_STATUS_PART1_DONE,
        created_at: now,
        finalized_at: 0,
    };
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: btc spv part 1 stored");
    Ok(())
}

fn process_submit_btc_proof_part_2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SubmitBtcProofPart2Args::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.block_header.len() != BLOCK_HEADER_LEN {
        return Err(ZpError::BlockHeaderInvalid.into());
    }

    let iter = &mut accounts.iter();
    let spv_proof_ai = next_account_info(iter)?;
    let submitter_ai = next_account_info(iter)?;

    assert_owned_by_program(spv_proof_ai, program_id)?;
    assert_signer(submitter_ai)?;

    let mut proof = SpvProofBtc::try_from_slice(&spv_proof_ai.data.borrow())
        .map_err(|_| ZpError::SpvWrongStatus)?;
    if proof.tag != SPV_PROOF_BTC_TAG {
        return Err(ZpError::SpvWrongStatus.into());
    }
    if proof.status != SPV_STATUS_PART1_DONE {
        return Err(ZpError::SpvWrongStatus.into());
    }
    if proof.submitter != *submitter_ai.key {
        return Err(ZpError::SpvSubmitterMismatch.into());
    }

    // Cheap structural checks first — wrong merkle root rules out the
    // proof without ever hashing the header.
    let header_root = spv::header_merkle_root(&args.block_header)
        .ok_or(ZpError::BlockHeaderInvalid)?;
    if header_root != proof.merkle_root {
        return Err(ZpError::MerkleRootMismatch.into());
    }

    let n_bits = spv::header_n_bits(&args.block_header)
        .ok_or(ZpError::BlockHeaderInvalid)?;
    let target = spv::n_bits_to_target(n_bits).ok_or(ZpError::BlockHeaderInvalid)?;

    // Expensive last: only hash the header once we've ruled out the
    // structural rejections.
    let block_hash = spv::sha256d(&args.block_header);
    if !spv::hash_le_meets_target_le(&block_hash, &target) {
        return Err(ZpError::PoWInsufficient.into());
    }

    proof.block_hash = block_hash;
    proof.status = SPV_STATUS_PART2_DONE;
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: btc spv part 2 verified");
    Ok(())
}

fn process_finalize_btc_payment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    // Args struct is empty — borsh's `try_from_slice` enforces that all
    // input bytes are consumed, so a payload with trailing bytes is
    // rejected as InvalidInstruction rather than silently ignored.
    let _args = FinalizeBtcPaymentArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    let iter = &mut accounts.iter();
    let spv_proof_ai = next_account_info(iter)?;
    let invoice_ai = next_account_info(iter)?;
    let merchant_ai = next_account_info(iter)?;
    let master_ai = next_account_info(iter)?;

    assert_owned_by_program(spv_proof_ai, program_id)?;
    assert_owned_by_program(invoice_ai, program_id)?;
    assert_owned_by_program(merchant_ai, program_id)?;
    assert_signer(master_ai)?;

    let mut proof = SpvProofBtc::try_from_slice(&spv_proof_ai.data.borrow())
        .map_err(|_| ZpError::SpvWrongStatus)?;
    if proof.tag != SPV_PROOF_BTC_TAG {
        return Err(ZpError::SpvWrongStatus.into());
    }
    if proof.status != SPV_STATUS_PART2_DONE {
        return Err(ZpError::SpvWrongStatus.into());
    }
    if proof.invoice != *invoice_ai.key {
        return Err(ZpError::SpvInvoiceMismatch.into());
    }

    let mut invoice = Invoice::try_from_slice(&invoice_ai.data.borrow())
        .map_err(|_| ZpError::NotInvoiceAccount)?;
    if invoice.tag != INVOICE_TAG {
        return Err(ZpError::NotInvoiceAccount.into());
    }
    if invoice.status != INVOICE_STATUS_OPEN {
        return Err(ZpError::InvoiceAlreadyPaid.into());
    }
    if invoice.merchant != *merchant_ai.key {
        return Err(ZpError::InvoiceMerchantMismatch.into());
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

    // `swept_at` is left at zero — semantically that field records a
    // USDC sweep, which never happens on the BTC settlement path. The
    // settlement timestamp lives on the proof's `finalized_at`.
    invoice.status = INVOICE_STATUS_PAID_BTC;
    invoice.serialize(&mut &mut invoice_ai.data.borrow_mut()[..])?;

    proof.status = SPV_STATUS_FINALIZED;
    proof.finalized_at = now;
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: btc payment finalized");
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

    #[test]
    fn spv_proof_btc_pda_seeds_match_module_constant() {
        // Same drift guard for the Z26.3 SPV proof PDA. The dispatcher
        // signs `create_account` for part_1 with seeds reconstructed
        // from `SPV_PROOF_BTC_SEED` and the invoice key; if that seed
        // constant ever drifts from what `find_spv_proof_btc_pda` uses
        // internally, the signed seeds won't match the discovered PDA
        // and `invoke_signed` errors at run time.
        let invoice = Pubkey::new_from_array([11u8; 32]);
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let (a, _) = find_spv_proof_btc_pda(&invoice, &program_id);
        let (b, _) = Pubkey::find_program_address(
            &[SPV_PROOF_BTC_SEED, invoice.as_ref()],
            &program_id,
        );
        assert_eq!(a, b);
    }
}
