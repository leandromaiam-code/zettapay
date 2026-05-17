//! ZettaPay Core — native Solana program (no Anchor).
//!
//! Ten instructions, discriminator-based dispatch on the leading byte of
//! `instruction_data`:
//!
//!   0  = RegisterMerchant     { master_pubkey, chains[] }
//!   1  = CreateInvoice        { amount, currency }
//!   2  = Sweep                { invoice_indexes[] }
//!   3  = SubmitBtcProofPart1  { tx_data, merkle_path, merkle_index } (Z26.3)
//!   4  = SubmitBtcProofPart2  { block_header (80 bytes) }            (Z26.3)
//!   5  = FinalizeBtcPayment   {}                                     (Z26.3)
//!   6  = InitBtcHeaderChain   { anchor_header, anchor_height }       (Z26.5)
//!   7  = UpdateBtcHeader      { new_header (80 bytes) }              (Z26.5)
//!   8  = InitProgramConfig    { max_invoice_amount }                 (Z30.1)
//!   9  = SetMaxInvoiceAmount  { max_invoice_amount }                 (Z30.1)
//!  10  = SubmitEthReceiptPart1 { token, from, to, amount,
//!                               receipt_hash, merkle_path,
//!                               merkle_index }                      (Z26.4)
//!  11  = SubmitEthReceiptPart2 { header_rlp, signing_payload,
//!                                signature, receipts_root_offset }  (Z26.4)
//!  12  = FinalizeEthPayment   {}                                    (Z26.4)
//!
//! State accounts (PDAs):
//!
//!   Merchant:           seeds = [b"merchant", master_pubkey]
//!   Invoice:            seeds = [master_pubkey, invoice_index_le]
//!   SpvProofBtc:        seeds = [b"spv-btc",  invoice_pubkey]       (Z26.3)
//!   SpvProofEth:        seeds = [b"spv-eth",  invoice_pubkey]       (Z26.4)
//!   BitcoinHeaderChain: seeds = [b"btc-header-chain"]   (singleton, Z26.5)
//!   ProgramConfig:      seeds = [b"program-config"]     (singleton, Z30.1)
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
//!   * `ethspv`       — Ethereum receipt-verifier crypto primitives
//!                      (Z26.4): keccak256, keccak-based merkle fold,
//!                      Transfer-log canonical hash, secp256k1 ecrecover
//!                      + Ethereum address derivation.
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
pub mod ethspv;
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
pub use ethspv::{
    compute_receipts_root_from_proof, keccak256, normalise_recovery_id, pubkey_to_eth_address,
    recover_eth_address, transfer_log_canonical_hash, ETH_ADDRESS_LEN, ETH_PUBKEY_LEN,
    ETH_SIGNATURE_LEN, TRANSFER_EVENT_SIGNATURE,
};
pub use instructions::{
    CreateInvoiceArgs, FinalizeBtcPaymentArgs, FinalizeEthPaymentArgs, InitBtcHeaderChainArgs,
    InitProgramConfigArgs, InstructionTag, RegisterMerchantArgs, SetMaxInvoiceAmountArgs,
    SubmitBtcProofPart1Args, SubmitBtcProofPart2Args, SubmitEthReceiptPart1Args,
    SubmitEthReceiptPart2Args, SweepArgs, UpdateBtcHeaderArgs,
};
pub use pda::{
    find_btc_header_chain_pda, find_invoice_pda, find_merchant_pda, find_program_config_pda,
    find_spv_proof_btc_pda, find_spv_proof_eth_pda, BTC_HEADER_CHAIN_SEED, INVOICE_INDEX_SEED_LEN,
    MERCHANT_SEED, PROGRAM_CONFIG_SEED, SPV_PROOF_BTC_SEED, SPV_PROOF_ETH_SEED,
};
pub use spv::{
    compute_merkle_root_from_proof, hash_le_meets_target_le, header_merkle_root, header_n_bits,
    header_prev_block_hash, n_bits_to_target, sha256d, BLOCK_HEADER_LEN, MAX_MERKLE_PROOF_DEPTH,
};
pub use state::{
    is_invoice_expired, BitcoinHeaderChain, Invoice, Merchant, ProgramConfig, SpvProofBtc,
    SpvProofEth, BTC_HEADER_CHAIN_BUFFER_LEN, BTC_HEADER_CHAIN_TAG, BTC_HEADER_CHAIN_WINDOW,
    BTC_HEADER_LEN, CHAIN_ARBITRUM, CHAIN_AVALANCHE, CHAIN_BASE, CHAIN_ETHEREUM, CHAIN_POLYGON,
    CHAIN_SOLANA, CURRENCY_USDC, DEFAULT_INVOICE_TTL_SECONDS, DEFAULT_MAX_INVOICE_AMOUNT,
    INVOICE_STATUS_OPEN, INVOICE_STATUS_PAID_BTC, INVOICE_STATUS_PAID_ETH, INVOICE_STATUS_SWEPT,
    INVOICE_TAG, MAX_CHAINS, MAX_INVOICE_AMOUNT_UNLIMITED, MERCHANT_TAG, PROGRAM_CONFIG_TAG,
    SPV_PROOF_BTC_TAG, SPV_PROOF_ETH_TAG, SPV_STATUS_FINALIZED, SPV_STATUS_PART1_DONE,
    SPV_STATUS_PART2_DONE,
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
        6 => process_init_btc_header_chain(program_id, accounts, payload),
        7 => process_update_btc_header(program_id, accounts, payload),
        8 => process_init_program_config(program_id, accounts, payload),
        9 => process_set_max_invoice_amount(program_id, accounts, payload),
        10 => process_submit_eth_receipt_part_1(program_id, accounts, payload),
        11 => process_submit_eth_receipt_part_2(program_id, accounts, payload),
        12 => process_finalize_eth_payment(program_id, accounts, payload),
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
    // Z30.1: config account is mandatory so the cap is enforced fail-
    // closed — a caller cannot opt out by omitting the account. Read
    // first, before any account creation, so an over-cap amount aborts
    // the transaction before paying rent.
    let program_config_ai = next_account_info(iter)?;

    assert_owned_by_program(merchant_ai, program_id)?;
    assert_signer(master_ai)?;
    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    assert_owned_by_program(program_config_ai, program_id)?;
    let (expected_config_pda, _) = find_program_config_pda(program_id);
    if program_config_ai.key != &expected_config_pda {
        return Err(ZpError::ProgramConfigPdaMismatch.into());
    }
    let config = ProgramConfig::try_from_slice(&program_config_ai.data.borrow())
        .map_err(|_| ZpError::NotProgramConfigAccount)?;
    if config.tag != PROGRAM_CONFIG_TAG {
        return Err(ZpError::NotProgramConfigAccount.into());
    }
    // Sentinel `0` disables enforcement (Z30.5 D+60 removal).
    if config.max_invoice_amount != MAX_INVOICE_AMOUNT_UNLIMITED
        && args.amount > config.max_invoice_amount
    {
        return Err(ZpError::InvoiceAmountExceedsCap.into());
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

// --- Z26.5: Bitcoin header chain (singleton PDA) --------------------------
//
// One global account, ~11.5 KB, tracks the most-recent 144 Bitcoin block
// headers. `init` bootstraps it from an anchor header (PoW-checked). After
// that, `update_btc_header` is callable by any wallet — replay protection
// comes for free from the continuity check, since the chain's
// `latest_hash` advances on every successful update.
//
// The instructions never move USDC and never touch any merchant or
// invoice account. They exist purely to maintain an on-chain reference
// chain that downstream verifiers (Z26.3 SPV proofs, future cross-chain
// settlement) can anchor their block-hash assertions against.

/// Run the standalone PoW check on an 80-byte Bitcoin block header, and
/// return its `sha256d` hash on success. Used by both `init` (validates
/// the anchor header) and `update` (validates each rolling tip).
fn validate_btc_header_pow(header: &[u8]) -> Result<[u8; 32], ZpError> {
    if header.len() != BLOCK_HEADER_LEN {
        return Err(ZpError::BlockHeaderInvalid);
    }
    let n_bits = spv::header_n_bits(header).ok_or(ZpError::BlockHeaderInvalid)?;
    let target = spv::n_bits_to_target(n_bits).ok_or(ZpError::BlockHeaderInvalid)?;
    let hash = spv::sha256d(header);
    if !spv::hash_le_meets_target_le(&hash, &target) {
        return Err(ZpError::PoWInsufficient);
    }
    Ok(hash)
}

fn process_init_btc_header_chain(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = InitBtcHeaderChainArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    let iter = &mut accounts.iter();
    let chain_ai = next_account_info(iter)?;
    let payer_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    let (expected_pda, bump) = find_btc_header_chain_pda(program_id);
    if chain_ai.key != &expected_pda {
        return Err(ZpError::HeaderChainPdaMismatch.into());
    }
    // Reject re-init: a populated header-chain account must be left to
    // its existing tip. Surface the precise code instead of leaking the
    // SystemProgram "already in use" error.
    if chain_ai.owner == program_id || !chain_ai.data.borrow().is_empty() {
        return Err(ZpError::HeaderChainAlreadyInitialized.into());
    }

    // Crypto first, allocation second — refuse to pay rent on a forged
    // anchor header.
    let anchor_hash = validate_btc_header_pow(&args.anchor_header)?;

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(BitcoinHeaderChain::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            chain_ai.key,
            lamports,
            BitcoinHeaderChain::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), chain_ai.clone(), system_ai.clone()],
        &[&[BTC_HEADER_CHAIN_SEED, &[bump]]],
    )?;

    // Allocate the ring buffer at full size up front. Subsequent updates
    // overwrite in place — the Vec's length never changes after init,
    // which keeps the borsh-serialized account size stable at SIZE.
    let mut headers_data = vec![0u8; BTC_HEADER_CHAIN_BUFFER_LEN];
    headers_data[..BTC_HEADER_LEN].copy_from_slice(&args.anchor_header);

    let chain = BitcoinHeaderChain {
        tag: BTC_HEADER_CHAIN_TAG,
        bump,
        head_index: 0,
        count: 1,
        latest_height: args.anchor_height,
        last_updated_at: Clock::get()?.unix_timestamp,
        anchor_height: args.anchor_height,
        anchor_hash,
        latest_hash: anchor_hash,
        headers_data,
    };
    chain.serialize(&mut &mut chain_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: btc header chain initialised");
    Ok(())
}

fn process_update_btc_header(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = UpdateBtcHeaderArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    let iter = &mut accounts.iter();
    let chain_ai = next_account_info(iter)?;

    assert_owned_by_program(chain_ai, program_id)?;

    let mut chain = BitcoinHeaderChain::try_from_slice(&chain_ai.data.borrow())
        .map_err(|_| ZpError::HeaderChainNotInitialized)?;
    if chain.tag != BTC_HEADER_CHAIN_TAG {
        return Err(ZpError::HeaderChainNotInitialized.into());
    }
    // The ring buffer's storage length is a load-bearing invariant —
    // every index math operation below assumes it. A wrong-length Vec
    // could only arise from manual account-data corruption, but failing
    // fast keeps that path off the happy path.
    if chain.headers_data.len() != BTC_HEADER_CHAIN_BUFFER_LEN {
        return Err(ZpError::HeaderChainCorrupted.into());
    }

    // Continuity: the supplied header must extend the chain tip. Check
    // before PoW so a wrong-fork submission gets the precise
    // HeaderChainDiscontinuous error rather than the more generic
    // PoWInsufficient (which would also fire on the same header against
    // a different tip).
    let prev_hash = spv::header_prev_block_hash(&args.new_header)
        .ok_or(ZpError::BlockHeaderInvalid)?;
    if prev_hash != chain.latest_hash {
        return Err(ZpError::HeaderChainDiscontinuous.into());
    }

    // PoW second. Returns the new block's sha256d for the chain tip
    // update below — `validate_btc_header_pow` already validates length.
    let new_hash = validate_btc_header_pow(&args.new_header)?;

    // Ring-buffer advance. The newest header always lands at
    // `(head_index + 1) mod WINDOW`; when `count` is at the window cap,
    // that slot is currently the oldest header, which is correctly
    // evicted by the overwrite. The widening through u32 keeps the
    // arithmetic safe under `overflow-checks = true` even on the
    // (program-unreachable) corruption case where `head_index` were
    // somehow at `u16::MAX`.
    let next_index = ((chain.head_index as u32 + 1)
        % BTC_HEADER_CHAIN_WINDOW as u32) as u16;
    let slot_start = (next_index as usize) * BTC_HEADER_LEN;
    chain.headers_data[slot_start..slot_start + BTC_HEADER_LEN]
        .copy_from_slice(&args.new_header);

    chain.head_index = next_index;
    if (chain.count as usize) < BTC_HEADER_CHAIN_WINDOW {
        chain.count = chain
            .count
            .checked_add(1)
            .ok_or(ZpError::Overflow)?;
    }
    chain.latest_hash = new_hash;
    chain.latest_height = chain
        .latest_height
        .checked_add(1)
        .ok_or(ZpError::Overflow)?;
    chain.last_updated_at = Clock::get()?.unix_timestamp;

    chain.serialize(&mut &mut chain_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: btc header chain advanced");
    Ok(())
}

// --- Z30.1: per-invoice cap + program config ----------------------------
//
// A singleton `ProgramConfig` account holds the per-invoice USDC cap that
// `process_create_invoice` enforces. The cap is updated by the operator
// via `set_max_invoice_amount` — gated on the authority recorded at
// `init_program_config` time, so a third party that knows the PDA cannot
// raise or remove the cap.
//
// Sprint Z30 expects the operator to call `init_program_config` once,
// immediately after the program is deployed, with the launch cap of
// 100 USDC. The cap-upgrade orchestrator (Z30.4 / Z30.5, see
// `packages/api/src/beta/cap_upgrade.ts`) re-broadcasts
// `set_max_invoice_amount` at D+30 ($500) and D+60 (cap removed, 0).

fn process_init_program_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = InitProgramConfigArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    let iter = &mut accounts.iter();
    let config_ai = next_account_info(iter)?;
    let authority_ai = next_account_info(iter)?;
    let payer_ai = next_account_info(iter)?;
    let system_ai = next_account_info(iter)?;

    assert_signer(authority_ai)?;
    assert_signer(payer_ai)?;
    assert_system_program(system_ai)?;

    let (expected_pda, bump) = find_program_config_pda(program_id);
    if config_ai.key != &expected_pda {
        return Err(ZpError::ProgramConfigPdaMismatch.into());
    }
    // Reject re-init: an already-populated config must keep its existing
    // authority + cap. Surface the precise code instead of leaking the
    // SystemProgram "already in use" error.
    if config_ai.owner == program_id || !config_ai.data.borrow().is_empty() {
        return Err(ZpError::ProgramConfigAlreadyInitialized.into());
    }

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(ProgramConfig::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            config_ai.key,
            lamports,
            ProgramConfig::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), config_ai.clone(), system_ai.clone()],
        &[&[PROGRAM_CONFIG_SEED, &[bump]]],
    )?;

    let config = ProgramConfig {
        tag: PROGRAM_CONFIG_TAG,
        bump,
        authority: *authority_ai.key,
        max_invoice_amount: args.max_invoice_amount,
    };
    config.serialize(&mut &mut config_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: program config initialised");
    Ok(())
}

fn process_set_max_invoice_amount(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SetMaxInvoiceAmountArgs::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    let iter = &mut accounts.iter();
    let config_ai = next_account_info(iter)?;
    let authority_ai = next_account_info(iter)?;

    assert_owned_by_program(config_ai, program_id)?;
    assert_signer(authority_ai)?;

    let (expected_pda, _) = find_program_config_pda(program_id);
    if config_ai.key != &expected_pda {
        return Err(ZpError::ProgramConfigPdaMismatch.into());
    }

    let mut config = ProgramConfig::try_from_slice(&config_ai.data.borrow())
        .map_err(|_| ZpError::ProgramConfigNotInitialized)?;
    if config.tag != PROGRAM_CONFIG_TAG {
        return Err(ZpError::NotProgramConfigAccount.into());
    }
    if config.authority != *authority_ai.key {
        return Err(ZpError::AuthorityMismatch.into());
    }

    config.max_invoice_amount = args.max_invoice_amount;
    config.serialize(&mut &mut config_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: max invoice amount updated");
    Ok(())
}

// --- Z26.4: Ethereum receipt verifier -----------------------------------
//
// Three transactions per receipt proof, tagged 10 / 11 / 12 — mirroring
// the Z26.3 Bitcoin SPV verifier shape:
//
//   part 1: parse the USDC Transfer log (token + from + to + amount),
//           recompute its canonical `log_hash`, fold the supplied
//           `receipt_hash` through the merkle authentication path into
//           the receipts root, and stash the commitments. Independent
//           of any block header.
//   part 2: validate that the supplied RLP-encoded block header carries
//           the receipts root we computed at the supplied offset and
//           that its Clique seal signature recovers a secp256k1 signer.
//           Records both the full-header block hash and the signer.
//   final:  flip the matching invoice to INVOICE_STATUS_PAID_ETH. There
//           is no on-chain USDC movement (premise 14: no custody) — the
//           transfer happened on Ethereum, finalize records that it did.
//
// CU budget: part 1's hot path is one keccak256 over the canonical
// commitment buffer (~160 bytes) plus one per merkle level. Part 2 is
// dominated by `secp256k1_recover` (~25k CU) and two keccak256 calls
// over the header payloads (~500–1500 bytes each). Both fit comfortably
// in the 200k per-instruction budget.

fn process_submit_eth_receipt_part_1(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SubmitEthReceiptPart1Args::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.amount == 0 {
        return Err(ZpError::EthTransferAmountZero.into());
    }
    if args.token == [0u8; 20] {
        return Err(ZpError::EthTokenAddressZero.into());
    }
    if args.merkle_path.len() > ethspv::MAX_MERKLE_PROOF_DEPTH {
        return Err(ZpError::EthMerkleProofTooLong.into());
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

    let (expected_pda, bump) = find_spv_proof_eth_pda(invoice_ai.key, program_id);
    if spv_proof_ai.key != &expected_pda {
        return Err(ZpError::EthSpvProofPdaMismatch.into());
    }
    // Reject re-init: an already-populated proof account must keep its
    // state; surface the precise code instead of leaking the
    // SystemProgram "already in use" error.
    if spv_proof_ai.owner == program_id || !spv_proof_ai.data.borrow().is_empty() {
        return Err(ZpError::EthSpvAlreadyInitialized.into());
    }

    // Crypto first, allocation second — if the commitments are forged
    // we want to fail before paying rent.
    let log_hash = ethspv::transfer_log_canonical_hash(
        &args.token,
        &args.from_addr,
        &args.to_addr,
        args.amount,
    );
    let receipts_root = ethspv::compute_receipts_root_from_proof(
        args.receipt_hash,
        &args.merkle_path,
        args.merkle_index,
    );

    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(SpvProofEth::SIZE);

    invoke_signed(
        &system_instruction::create_account(
            payer_ai.key,
            spv_proof_ai.key,
            lamports,
            SpvProofEth::SIZE as u64,
            program_id,
        ),
        &[payer_ai.clone(), spv_proof_ai.clone(), system_ai.clone()],
        &[&[SPV_PROOF_ETH_SEED, invoice_ai.key.as_ref(), &[bump]]],
    )?;

    let now = Clock::get()?.unix_timestamp;
    let proof = SpvProofEth {
        tag: SPV_PROOF_ETH_TAG,
        bump,
        invoice: *invoice_ai.key,
        submitter: *submitter_ai.key,
        token: args.token,
        from_addr: args.from_addr,
        to_addr: args.to_addr,
        amount: args.amount,
        log_hash,
        receipts_root,
        block_hash: [0u8; 32],
        block_signer: [0u8; 20],
        status: SPV_STATUS_PART1_DONE,
        created_at: now,
        finalized_at: 0,
    };
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: eth receipt part 1 stored");
    Ok(())
}

fn process_submit_eth_receipt_part_2(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    let args = SubmitEthReceiptPart2Args::try_from_slice(payload)
        .map_err(|_| ZpError::InvalidInstruction)?;

    if args.header_rlp.is_empty() || args.signing_payload.is_empty() {
        return Err(ZpError::EthBlockHeaderInvalid.into());
    }
    if args.signature.len() != ethspv::ETH_SIGNATURE_LEN {
        return Err(ZpError::EthBlockHeaderInvalid.into());
    }
    // The receipts_root field must sit entirely inside `header_rlp`. A
    // forged offset that overruns the buffer would otherwise slice-
    // panic in debug builds and underflow in release; bail explicitly.
    let offset = args.receipts_root_offset as usize;
    let end = offset.checked_add(32).ok_or(ZpError::EthBlockHeaderInvalid)?;
    if end > args.header_rlp.len() {
        return Err(ZpError::EthBlockHeaderInvalid.into());
    }

    let iter = &mut accounts.iter();
    let spv_proof_ai = next_account_info(iter)?;
    let submitter_ai = next_account_info(iter)?;

    assert_owned_by_program(spv_proof_ai, program_id)?;
    assert_signer(submitter_ai)?;

    let mut proof = SpvProofEth::try_from_slice(&spv_proof_ai.data.borrow())
        .map_err(|_| ZpError::EthSpvWrongStatus)?;
    if proof.tag != SPV_PROOF_ETH_TAG {
        return Err(ZpError::EthSpvWrongStatus.into());
    }
    if proof.status != SPV_STATUS_PART1_DONE {
        return Err(ZpError::EthSpvWrongStatus.into());
    }
    if proof.submitter != *submitter_ai.key {
        return Err(ZpError::EthSpvSubmitterMismatch.into());
    }

    // Cheap structural check first — wrong receipts_root rules out the
    // proof without ever hashing the header or running ecrecover.
    let mut header_receipts_root = [0u8; 32];
    header_receipts_root.copy_from_slice(&args.header_rlp[offset..end]);
    if header_receipts_root != proof.receipts_root {
        return Err(ZpError::EthReceiptsRootMismatch.into());
    }

    let mut sig_buf = [0u8; ETH_SIGNATURE_LEN];
    sig_buf.copy_from_slice(&args.signature);

    let signing_hash = ethspv::keccak256(&args.signing_payload);
    let block_signer = ethspv::recover_eth_address(&signing_hash, &sig_buf)
        .ok_or(ZpError::EthSignatureRecoveryFailed)?;
    let block_hash = ethspv::keccak256(&args.header_rlp);

    proof.block_hash = block_hash;
    proof.block_signer = block_signer;
    proof.status = SPV_STATUS_PART2_DONE;
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: eth receipt part 2 verified");
    Ok(())
}

fn process_finalize_eth_payment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    payload: &[u8],
) -> ProgramResult {
    // Args struct is empty — borsh's `try_from_slice` enforces all input
    // bytes are consumed, so a payload with trailing bytes is rejected
    // as InvalidInstruction rather than silently ignored.
    let _args = FinalizeEthPaymentArgs::try_from_slice(payload)
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

    let mut proof = SpvProofEth::try_from_slice(&spv_proof_ai.data.borrow())
        .map_err(|_| ZpError::EthSpvWrongStatus)?;
    if proof.tag != SPV_PROOF_ETH_TAG {
        return Err(ZpError::EthSpvWrongStatus.into());
    }
    if proof.status != SPV_STATUS_PART2_DONE {
        return Err(ZpError::EthSpvWrongStatus.into());
    }
    if proof.invoice != *invoice_ai.key {
        return Err(ZpError::EthSpvInvoiceMismatch.into());
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

    // `swept_at` stays 0 — like the BTC path, semantically that field
    // records a USDC sweep which never happens on the ETH settlement
    // rail. The settlement timestamp lives on the proof's `finalized_at`.
    invoice.status = INVOICE_STATUS_PAID_ETH;
    invoice.serialize(&mut &mut invoice_ai.data.borrow_mut()[..])?;

    proof.status = SPV_STATUS_FINALIZED;
    proof.finalized_at = now;
    proof.serialize(&mut &mut spv_proof_ai.data.borrow_mut()[..])?;

    msg!("zettapay-core: eth payment finalized");
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
    fn btc_header_chain_pda_seeds_match_module_constant() {
        // The Z26.5 init handler signs `create_account` with seeds
        // reconstructed from `BTC_HEADER_CHAIN_SEED`. Drift between
        // that constant and what `find_btc_header_chain_pda` uses
        // internally would make `invoke_signed` fail at run time.
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let (a, _) = find_btc_header_chain_pda(&program_id);
        let (b, _) = Pubkey::find_program_address(
            &[BTC_HEADER_CHAIN_SEED],
            &program_id,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn program_config_pda_seeds_match_module_constant() {
        // The Z30.1 init handler signs `create_account` with seeds
        // reconstructed from `PROGRAM_CONFIG_SEED`. Drift between this
        // constant and what `find_program_config_pda` uses internally
        // would make `invoke_signed` fail at run time.
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let (a, _) = find_program_config_pda(&program_id);
        let (b, _) =
            Pubkey::find_program_address(&[PROGRAM_CONFIG_SEED], &program_id);
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

    #[test]
    fn spv_proof_eth_pda_seeds_match_module_constant() {
        // Z26.4 drift guard. The ETH receipt-verifier dispatcher signs
        // `create_account` for part_1 with seeds reconstructed from
        // `SPV_PROOF_ETH_SEED` and the invoice key; drift between the
        // constant and what `find_spv_proof_eth_pda` uses would make
        // `invoke_signed` fail at run time.
        let invoice = Pubkey::new_from_array([13u8; 32]);
        let program_id = Pubkey::new_from_array([42u8; 32]);
        let (a, _) = find_spv_proof_eth_pda(&invoice, &program_id);
        let (b, _) = Pubkey::find_program_address(
            &[SPV_PROOF_ETH_SEED, invoice.as_ref()],
            &program_id,
        );
        assert_eq!(a, b);
    }

    #[test]
    fn eth_spv_status_alphabet_is_shared_with_btc() {
        // The ETH receipt proof reuses the SPV status alphabet (PART1 /
        // PART2 / FINALIZED) so off-chain dashboards render both chains
        // through a single pipeline. A future refactor that split the
        // ETH lifecycle into its own status enum without updating the
        // dashboard would silently break that contract — pin the
        // alphabet here so the breaking change trips the test first.
        assert_eq!(SPV_STATUS_PART1_DONE, 0);
        assert_eq!(SPV_STATUS_PART2_DONE, 1);
        assert_eq!(SPV_STATUS_FINALIZED, 2);
    }

    #[test]
    fn eth_paid_status_distinct_from_btc_swept_and_open() {
        // `INVOICE_STATUS_PAID_ETH` must not collide with any other
        // status byte. Downstream indexers fan out on this value to
        // route dispute resolution through the correct settlement
        // chain — a collision with `PAID_BTC` would send ETH disputes
        // through the BTC SPV path.
        assert_ne!(INVOICE_STATUS_PAID_ETH, INVOICE_STATUS_OPEN);
        assert_ne!(INVOICE_STATUS_PAID_ETH, INVOICE_STATUS_SWEPT);
        assert_ne!(INVOICE_STATUS_PAID_ETH, INVOICE_STATUS_PAID_BTC);
    }
}
