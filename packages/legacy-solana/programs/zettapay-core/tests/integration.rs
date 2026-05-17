//! In-process integration tests for `zettapay-core`.
//!
//! Runs the native Rust program through `solana-program-test`'s
//! `BanksClient` — same dispatcher path as devnet, but without the SBF
//! toolchain or RPC round-trips. Per-module unit tests in `src/` cover
//! pure helpers (PDA derivation, Borsh round-trips, validation primitives);
//! this file exercises the three instructions end-to-end.
//!
//! Coverage (Z25.3 mission spec):
//!
//!   1. register valid                    → `register_creates_merchant_pda`
//!   2. register repeated                 → `register_twice_same_master_fails`
//!   3. create_invoice valid              → `create_invoice_writes_open_account_and_bumps_count`
//!   4. sweep authorized                  → `sweep_flips_status_to_swept`
//!   5. sweep unauthorized (rejected)     → `sweep_with_wrong_master_signer_is_rejected`
//!   6. edge cases                        → `register_*`, `create_invoice_*`, `sweep_*` below
//!
//! Each test is hermetic: a fresh `BanksClient` per test, fresh keypairs,
//! no shared state.

use borsh::{BorshDeserialize, BorshSerialize};
use solana_program::{
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    system_program,
};
use solana_program_test::{processor, BanksClient, ProgramTest};
use solana_sdk::{
    account::Account,
    signature::{Keypair, Signer},
    transaction::{Transaction, TransactionError},
};
use solana_sdk::instruction::InstructionError;

use zettapay_core::{
    find_btc_header_chain_pda, find_invoice_pda, find_merchant_pda, find_program_config_pda,
    find_spv_proof_btc_pda, find_spv_proof_eth_pda, process_instruction, sha256d, BitcoinHeaderChain,
    CreateInvoiceArgs, InitBtcHeaderChainArgs, InitProgramConfigArgs, Invoice, InstructionTag,
    Merchant, ProgramConfig, RegisterMerchantArgs, SetMaxInvoiceAmountArgs, SubmitBtcProofPart1Args,
    SubmitEthReceiptPart1Args, SweepArgs, UpdateBtcHeaderArgs, BLOCK_HEADER_LEN, CHAIN_BASE,
    CHAIN_ETHEREUM, CHAIN_SOLANA, CURRENCY_USDC, DEFAULT_MAX_INVOICE_AMOUNT, INVOICE_STATUS_OPEN,
    INVOICE_STATUS_SWEPT, INVOICE_TAG, MAX_CHAINS, MERCHANT_TAG, PROGRAM_CONFIG_TAG, ZpError,
};

// Program id baked into `declare_id!` at compile time. Tests reuse it so
// PDAs derived in the test code match those the program derives inside the
// dispatcher.
fn program_id() -> Pubkey {
    zettapay_core::ID
}

fn program_test() -> ProgramTest {
    ProgramTest::new(
        "zettapay_core",
        program_id(),
        processor!(process_instruction),
    )
}

// --- instruction builders -------------------------------------------------

fn ix_register_merchant(
    master: &Pubkey,
    payer: &Pubkey,
    chains: Vec<u8>,
) -> Instruction {
    let (merchant_pda, _) = find_merchant_pda(master, &program_id());
    let args = RegisterMerchantArgs {
        master_pubkey: *master,
        chains,
    };
    let mut data = vec![InstructionTag::RegisterMerchant as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(merchant_pda, false),
            AccountMeta::new_readonly(*master, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

fn ix_create_invoice(
    master: &Pubkey,
    payer: &Pubkey,
    invoice_index: u64,
    amount: u64,
    currency: u8,
) -> Instruction {
    let (merchant_pda, _) = find_merchant_pda(master, &program_id());
    let (invoice_pda, _) = find_invoice_pda(master, invoice_index, &program_id());
    let (config_pda, _) = find_program_config_pda(&program_id());
    let args = CreateInvoiceArgs { amount, currency };
    let mut data = vec![InstructionTag::CreateInvoice as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(merchant_pda, false),
            AccountMeta::new_readonly(*master, true),
            AccountMeta::new(invoice_pda, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(config_pda, false),
        ],
        data,
    }
}

fn ix_init_program_config(
    authority: &Pubkey,
    payer: &Pubkey,
    max_invoice_amount: u64,
) -> Instruction {
    let (config_pda, _) = find_program_config_pda(&program_id());
    let args = InitProgramConfigArgs { max_invoice_amount };
    let mut data = vec![InstructionTag::InitProgramConfig as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda, false),
            AccountMeta::new_readonly(*authority, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

fn ix_set_max_invoice_amount(authority: &Pubkey, max_invoice_amount: u64) -> Instruction {
    let (config_pda, _) = find_program_config_pda(&program_id());
    let args = SetMaxInvoiceAmountArgs { max_invoice_amount };
    let mut data = vec![InstructionTag::SetMaxInvoiceAmount as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(config_pda, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data,
    }
}

fn ix_sweep(
    merchant_master: &Pubkey,
    signer_master: &Pubkey,
    invoice_indexes: Vec<u64>,
) -> Instruction {
    // `merchant_master` is the master baked into the merchant PDA + invoice
    // PDAs (what the program will compute against). `signer_master` is the
    // pubkey we put in the `master` slot — usually the same, but split so
    // negative tests can pass a different signer.
    let (merchant_pda, _) = find_merchant_pda(merchant_master, &program_id());
    let mut accounts = vec![
        AccountMeta::new(merchant_pda, false),
        AccountMeta::new_readonly(*signer_master, true),
    ];
    for idx in &invoice_indexes {
        let (invoice_pda, _) = find_invoice_pda(merchant_master, *idx, &program_id());
        accounts.push(AccountMeta::new(invoice_pda, false));
    }
    let args = SweepArgs { invoice_indexes };
    let mut data = vec![InstructionTag::Sweep as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts,
        data,
    }
}

// --- helpers --------------------------------------------------------------

async fn send(
    banks: &mut BanksClient,
    payer: &Keypair,
    signers: &[&Keypair],
    ixs: &[Instruction],
) -> Result<(), TransactionError> {
    let blockhash = banks.get_latest_blockhash().await.unwrap();
    let mut all: Vec<&Keypair> = vec![payer];
    all.extend(signers);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
    banks
        .process_transaction(tx)
        .await
        .map_err(|e| e.unwrap())
}

/// Run `init_program_config` so the `create_invoice` cap-enforcement path
/// has a singleton config to read. Tests that don't touch `create_invoice`
/// can skip this — they will fail on the missing config_ai account if
/// they do exercise `create_invoice` without it.
async fn init_default_config(banks: &mut BanksClient, payer: &Keypair) {
    let authority = payer; // tests reuse the payer as the bound authority
    send(
        banks,
        payer,
        &[authority],
        &[ix_init_program_config(
            &authority.pubkey(),
            &payer.pubkey(),
            DEFAULT_MAX_INVOICE_AMOUNT,
        )],
    )
    .await
    .expect("init_program_config should succeed in test bootstrap");
}

async fn fetch_program_config(banks: &mut BanksClient) -> ProgramConfig {
    let (pda, _) = find_program_config_pda(&program_id());
    let acc: Account = banks
        .get_account(pda)
        .await
        .unwrap()
        .expect("program config account");
    assert_eq!(acc.owner, program_id());
    ProgramConfig::try_from_slice(&acc.data).expect("program config decodes")
}

async fn fetch_merchant(banks: &mut BanksClient, master: &Pubkey) -> Merchant {
    let (pda, _) = find_merchant_pda(master, &program_id());
    let acc: Account = banks.get_account(pda).await.unwrap().expect("merchant account");
    assert_eq!(acc.owner, program_id());
    Merchant::try_from_slice(&acc.data).expect("merchant decodes")
}

async fn fetch_invoice(
    banks: &mut BanksClient,
    master: &Pubkey,
    idx: u64,
) -> Invoice {
    let (pda, _) = find_invoice_pda(master, idx, &program_id());
    let acc: Account = banks.get_account(pda).await.unwrap().expect("invoice account");
    assert_eq!(acc.owner, program_id());
    Invoice::try_from_slice(&acc.data).expect("invoice decodes")
}

fn extract_custom(err: &TransactionError) -> Option<u32> {
    match err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(*code),
        _ => None,
    }
}

// --- 1. register valid ----------------------------------------------------

#[tokio::test]
async fn register_creates_merchant_pda() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA, CHAIN_ETHEREUM],
        )],
    )
    .await
    .expect("register should succeed");

    let m = fetch_merchant(&mut banks, &master.pubkey()).await;
    assert_eq!(m.tag, MERCHANT_TAG);
    assert_eq!(m.master_pubkey, master.pubkey());
    assert_eq!(m.chains, vec![CHAIN_SOLANA, CHAIN_ETHEREUM]);
    assert_eq!(m.invoice_count, 0);
    assert!(m.registered_at > 0);
}

// --- 2. register repeated -------------------------------------------------

#[tokio::test]
async fn register_twice_same_master_fails() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .expect("first register should succeed");

    // Second register against the same master targets the same PDA. The
    // system program's `create_account` rejects with
    // `SystemError::AccountAlreadyInUse` because the PDA is already
    // initialized — surfaces here as an `InstructionError` from the
    // dispatcher.
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .expect_err("re-register must fail");

    assert!(
        matches!(err, TransactionError::InstructionError(_, _)),
        "expected an instruction error, got {err:?}"
    );
}

// --- 3. create_invoice valid ---------------------------------------------

#[tokio::test]
async fn create_invoice_writes_open_account_and_bumps_count() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            5_000_000, // 5 USDC (6 decimals)
            CURRENCY_USDC,
        )],
    )
    .await
    .expect("create_invoice should succeed");

    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.tag, INVOICE_TAG);
    assert_eq!(inv.invoice_index, 0);
    assert_eq!(inv.amount, 5_000_000);
    assert_eq!(inv.currency, CURRENCY_USDC);
    assert_eq!(inv.status, INVOICE_STATUS_OPEN);
    assert_eq!(inv.swept_at, 0);

    let m = fetch_merchant(&mut banks, &master.pubkey()).await;
    assert_eq!(m.invoice_count, 1, "invoice_count must monotonically increment");
}

// --- 4. sweep authorized -------------------------------------------------

#[tokio::test]
async fn sweep_flips_status_to_swept() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            1,
            2_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![0, 1])],
    )
    .await
    .expect("sweep authorized by master should succeed");

    let i0 = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    let i1 = fetch_invoice(&mut banks, &master.pubkey(), 1).await;
    assert_eq!(i0.status, INVOICE_STATUS_SWEPT);
    assert_eq!(i1.status, INVOICE_STATUS_SWEPT);
    assert!(i0.swept_at > 0);
    assert!(i1.swept_at > 0);
}

// --- 5. sweep unauthorized (rejected) ------------------------------------

#[tokio::test]
async fn sweep_with_wrong_master_signer_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();
    let attacker = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();

    // Build sweep that addresses the real merchant PDA + invoice PDA but
    // passes `attacker` as the signing master. The program loads the
    // merchant and rejects when `merchant.master_pubkey != attacker.key`.
    let ix = ix_sweep(&master.pubkey(), &attacker.pubkey(), vec![0]);
    let err = send(&mut banks, &payer, &[&attacker], &[ix])
        .await
        .expect_err("sweep with non-master signer must be rejected");

    assert_eq!(
        extract_custom(&err),
        Some(ZpError::MasterMismatch as u32),
        "expected MasterMismatch, got {err:?}"
    );

    // And the invoice remains Open — the rejected tx must not have written
    // any state.
    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.status, INVOICE_STATUS_OPEN);
    assert_eq!(inv.swept_at, 0);
}

// --- 6. edge cases --------------------------------------------------------

#[tokio::test]
async fn register_with_empty_chains_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(&master.pubkey(), &payer.pubkey(), vec![])],
    )
    .await
    .expect_err("empty chains must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::ChainsEmpty as u32));
}

#[tokio::test]
async fn register_without_solana_chain_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    // Premise 1: Solana is the only chain in V1 — registration without it
    // is a configuration mistake the program refuses to record.
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_ETHEREUM, CHAIN_BASE],
        )],
    )
    .await
    .expect_err("missing Solana chain must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::SolanaChainRequired as u32)
    );
}

#[tokio::test]
async fn register_with_chains_over_max_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    let oversized = vec![CHAIN_SOLANA; MAX_CHAINS + 1];
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            oversized,
        )],
    )
    .await
    .expect_err("chains > MAX_CHAINS must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::ChainsTooLong as u32));
}

#[tokio::test]
async fn register_with_unknown_chain_tag_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA, 99],
        )],
    )
    .await
    .expect_err("unknown chain tag must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::UnknownChain as u32));
}

#[tokio::test]
async fn create_invoice_with_zero_amount_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            0,
            CURRENCY_USDC,
        )],
    )
    .await
    .expect_err("amount=0 must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::AmountZero as u32));
}

#[tokio::test]
async fn create_invoice_with_unsupported_currency_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    // Premise 2: USDC is the only currency in V1. The currency tag is one
    // byte so any non-zero value is a not-yet-supported asset.
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            1, // unsupported
        )],
    )
    .await
    .expect_err("non-USDC currency must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::CurrencyUnsupported as u32)
    );
}

#[tokio::test]
async fn sweep_with_empty_index_list_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![])],
    )
    .await
    .expect_err("empty invoice list must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::NoInvoices as u32));
}

#[tokio::test]
async fn sweep_of_already_swept_invoice_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![0])],
    )
    .await
    .unwrap();

    // Sweep is one-shot per invoice. Replays must error so the off-chain
    // ledger doesn't double-credit a payout if a retry races.
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![0])],
    )
    .await
    .expect_err("re-sweep of a Swept invoice must be rejected");
    assert_eq!(extract_custom(&err), Some(ZpError::InvoiceNotOpen as u32));
}

// --- 7. Z30.1: per-invoice cap + program config -------------------------

#[tokio::test]
async fn init_program_config_writes_authority_and_cap() {
    let (mut banks, payer, _) = program_test().start().await;
    let authority = Keypair::new();

    send(
        &mut banks,
        &payer,
        &[&authority],
        &[ix_init_program_config(
            &authority.pubkey(),
            &payer.pubkey(),
            DEFAULT_MAX_INVOICE_AMOUNT,
        )],
    )
    .await
    .expect("init_program_config should succeed");

    let cfg = fetch_program_config(&mut banks).await;
    assert_eq!(cfg.tag, PROGRAM_CONFIG_TAG);
    assert_eq!(cfg.authority, authority.pubkey());
    assert_eq!(cfg.max_invoice_amount, DEFAULT_MAX_INVOICE_AMOUNT);
}

#[tokio::test]
async fn init_program_config_twice_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;

    init_default_config(&mut banks, &payer).await;

    // Second init must error — re-init would silently replace the
    // captured authority and the beta cap, which is the exact privilege-
    // escalation path the program config exists to close.
    let err = send(
        &mut banks,
        &payer,
        &[&payer],
        &[ix_init_program_config(
            &payer.pubkey(),
            &payer.pubkey(),
            500_000_000,
        )],
    )
    .await
    .expect_err("second init must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::ProgramConfigAlreadyInitialized as u32)
    );
}

#[tokio::test]
async fn create_invoice_amount_at_cap_succeeds() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    // Boundary check: amount == cap is allowed. Strictly-greater-than
    // rule is the documented contract; an off-by-one would either
    // sandbag legitimate $100 invoices or leak a $100.000_001 escape.
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            DEFAULT_MAX_INVOICE_AMOUNT,
            CURRENCY_USDC,
        )],
    )
    .await
    .expect("amount equal to cap should succeed");

    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.amount, DEFAULT_MAX_INVOICE_AMOUNT);
}

#[tokio::test]
async fn create_invoice_amount_above_cap_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    // One base unit above the cap (100_000_001). Rejection must surface
    // the precise `InvoiceAmountExceedsCap` so the off-chain orchestrator
    // can distinguish a cap denial from a generic invoice failure.
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            DEFAULT_MAX_INVOICE_AMOUNT + 1,
            CURRENCY_USDC,
        )],
    )
    .await
    .expect_err("amount above cap must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::InvoiceAmountExceedsCap as u32)
    );

    // Merchant invoice_count must not advance on a rejected create.
    let m = fetch_merchant(&mut banks, &master.pubkey()).await;
    assert_eq!(m.invoice_count, 0);
}

#[tokio::test]
async fn set_max_invoice_amount_by_authority_succeeds() {
    let (mut banks, payer, _) = program_test().start().await;

    init_default_config(&mut banks, &payer).await;

    // Z30.4 cap upgrade: lift from $100 to $500. Authority == payer
    // because `init_default_config` binds the payer as authority.
    let new_cap = 500_000_000u64;
    send(
        &mut banks,
        &payer,
        &[&payer],
        &[ix_set_max_invoice_amount(&payer.pubkey(), new_cap)],
    )
    .await
    .expect("authority-signed set_max_invoice_amount should succeed");

    let cfg = fetch_program_config(&mut banks).await;
    assert_eq!(cfg.max_invoice_amount, new_cap);
}

#[tokio::test]
async fn set_max_invoice_amount_by_non_authority_is_rejected() {
    let (mut banks, payer, _) = program_test().start().await;
    let attacker = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    // The cap-setter is the captured authority, not just any signer.
    // An attacker that signs the tx but doesn't match the stored
    // authority must be rejected with `AuthorityMismatch` so the
    // off-chain monitor can alert on the attempt.
    let err = send(
        &mut banks,
        &payer,
        &[&attacker],
        &[ix_set_max_invoice_amount(&attacker.pubkey(), 999_999_999)],
    )
    .await
    .expect_err("non-authority set must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::AuthorityMismatch as u32)
    );

    // Cap must remain at the original value.
    let cfg = fetch_program_config(&mut banks).await;
    assert_eq!(cfg.max_invoice_amount, DEFAULT_MAX_INVOICE_AMOUNT);
}

#[tokio::test]
async fn create_invoice_after_cap_disabled_allows_any_amount() {
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;

    // Z30.5 D+60 removal: authority sets cap to 0 (sentinel for
    // unlimited). Subsequent invoices of any size must clear.
    send(
        &mut banks,
        &payer,
        &[&payer],
        &[ix_set_max_invoice_amount(&payer.pubkey(), 0)],
    )
    .await
    .expect("disabling cap should succeed");

    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();

    let huge = 10_000_000_000u64; // 10_000 USDC, well above the original cap
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            huge,
            CURRENCY_USDC,
        )],
    )
    .await
    .expect("amount above original cap must succeed once cap is disabled");

    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.amount, huge);
}

// --- 8. Z28.5 edge cases --------------------------------------------------
//
// Each test below documents one of the failure modes the spec calls out:
//
//   * chain reorg simulation (BTC header chain) — competing fork at the
//     same parent is rejected with `HeaderChainDiscontinuous` once the
//     legitimate tip has advanced.
//   * double payment same invoice — a SPV proof (BTC or ETH) cannot be
//     opened against an invoice whose lifecycle has already terminated
//     (Swept). `InvoiceAlreadyPaid` is the program-level guard the
//     off-chain dispatcher relies on so a retry race cannot record two
//     settlements for one invoice.
//   * sweep with invalid invoice indexes — sweeping with an account list
//     that does not correspond to the supplied indexes (uninitialized
//     PDA, cross-merchant PDA, mismatched length) is the canonical caller-
//     bug the program refuses to silently round-trip.

// --- shared regtest helpers ----------------------------------------------

/// Bitcoin regtest difficulty. Decodes to the target with the top byte
/// equal to `0x7f` and the next two bytes `0xff` — so any hash whose
/// most-significant byte is ≤ 0x7f satisfies PoW. About 50% of arbitrary
/// nonces clear the bar, so the grind loop below converges instantly.
const REGTEST_N_BITS: u32 = 0x207f_ffff;

/// Mine a regtest-difficulty Bitcoin block header. Pure CPU; the grind is
/// bounded by `u32::MAX` and converges in ≈1–2 iterations because the
/// regtest target leaves the top byte free.
///
/// The returned header is byte-for-byte usable in `init_btc_header_chain`
/// + `update_btc_header` — both validate PoW via the same predicate this
/// loop checks.
fn mine_regtest_header(
    prev_hash: [u8; 32],
    merkle_root: [u8; 32],
    timestamp: u32,
) -> [u8; BLOCK_HEADER_LEN] {
    let mut header = [0u8; BLOCK_HEADER_LEN];
    header[0..4].copy_from_slice(&1u32.to_le_bytes());
    header[4..36].copy_from_slice(&prev_hash);
    header[36..68].copy_from_slice(&merkle_root);
    header[68..72].copy_from_slice(&timestamp.to_le_bytes());
    header[72..76].copy_from_slice(&REGTEST_N_BITS.to_le_bytes());
    for nonce in 0u32..u32::MAX {
        header[76..80].copy_from_slice(&nonce.to_le_bytes());
        let hash = sha256d(&header);
        // Regtest target = ... 0xff 0xff 0x7f (bytes 29, 30, 31). The
        // top byte dominates the LE comparison: hash[31] <= 0x7f
        // suffices because target[30] = 0xff which dominates whatever
        // hash[30] turns out to be.
        if hash[31] <= 0x7f {
            return header;
        }
    }
    panic!("regtest mining ran past u32::MAX without a valid nonce");
}

fn ix_init_btc_header_chain(
    payer: &Pubkey,
    anchor_header: &[u8],
    anchor_height: u64,
) -> Instruction {
    let (chain_pda, _) = find_btc_header_chain_pda(&program_id());
    let args = InitBtcHeaderChainArgs {
        anchor_header: anchor_header.to_vec(),
        anchor_height,
    };
    let mut data = vec![InstructionTag::InitBtcHeaderChain as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(chain_pda, false),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

fn ix_update_btc_header(new_header: &[u8]) -> Instruction {
    let (chain_pda, _) = find_btc_header_chain_pda(&program_id());
    let args = UpdateBtcHeaderArgs {
        new_header: new_header.to_vec(),
    };
    let mut data = vec![InstructionTag::UpdateBtcHeader as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![AccountMeta::new(chain_pda, false)],
        data,
    }
}

fn ix_submit_btc_proof_part_1(
    invoice: &Pubkey,
    submitter: &Pubkey,
    payer: &Pubkey,
    tx_data: Vec<u8>,
    merkle_path: Vec<[u8; 32]>,
    merkle_index: u32,
) -> Instruction {
    let (spv_proof_pda, _) = find_spv_proof_btc_pda(invoice, &program_id());
    let args = SubmitBtcProofPart1Args {
        tx_data,
        merkle_path,
        merkle_index,
    };
    let mut data = vec![InstructionTag::SubmitBtcProofPart1 as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(spv_proof_pda, false),
            AccountMeta::new_readonly(*invoice, false),
            AccountMeta::new_readonly(*submitter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

fn ix_submit_eth_receipt_part_1(
    invoice: &Pubkey,
    submitter: &Pubkey,
    payer: &Pubkey,
) -> Instruction {
    let (spv_proof_pda, _) = find_spv_proof_eth_pda(invoice, &program_id());
    let args = SubmitEthReceiptPart1Args {
        token: [0x11u8; 20],
        from_addr: [0x22u8; 20],
        to_addr: [0x33u8; 20],
        amount: 1_500_000,
        receipt_hash: [0x44u8; 32],
        merkle_path: vec![[7u8; 32]],
        merkle_index: 0,
    };
    let mut data = vec![InstructionTag::SubmitEthReceiptPart1 as u8];
    args.serialize(&mut data).unwrap();
    Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(spv_proof_pda, false),
            AccountMeta::new_readonly(*invoice, false),
            AccountMeta::new_readonly(*submitter, true),
            AccountMeta::new(*payer, true),
            AccountMeta::new_readonly(system_program::ID, false),
        ],
        data,
    }
}

async fn fetch_header_chain(banks: &mut BanksClient) -> BitcoinHeaderChain {
    let (pda, _) = find_btc_header_chain_pda(&program_id());
    let acc: Account = banks
        .get_account(pda)
        .await
        .unwrap()
        .expect("header chain account");
    assert_eq!(acc.owner, program_id());
    BitcoinHeaderChain::try_from_slice(&acc.data).expect("header chain decodes")
}

// --- 8a. chain reorg simulation BTC --------------------------------------

#[tokio::test]
async fn btc_header_chain_rejects_reorg_attempt_from_already_extended_parent() {
    // Init the chain at anchor H0. Extend it to H1 (the new tip). Then
    // submit a competing fork H1' that also names H0 as parent — the
    // canonical chain-reorg attempt at depth 1. Because the chain's
    // `latest_hash` has already moved to H1, the prev-hash equality
    // check inside `update_btc_header` rejects H1' with
    // `HeaderChainDiscontinuous` instead of silently swapping the tip.
    let (mut banks, payer, _) = program_test().start().await;

    let h0 = mine_regtest_header([0u8; 32], [0xa1u8; 32], 1_700_000_000);
    let h0_hash = sha256d(&h0);
    send(
        &mut banks,
        &payer,
        &[],
        &[ix_init_btc_header_chain(&payer.pubkey(), &h0, 800_000)],
    )
    .await
    .expect("init btc header chain should succeed");

    let h1 = mine_regtest_header(h0_hash, [0xa2u8; 32], 1_700_000_600);
    send(&mut banks, &payer, &[], &[ix_update_btc_header(&h1)])
        .await
        .expect("legitimate extension to H1 should succeed");
    let h1_hash = sha256d(&h1);

    // Competing fork: same parent as H1 (H0), different merkle_root.
    let h1_prime = mine_regtest_header(h0_hash, [0xb2u8; 32], 1_700_000_700);
    let err = send(&mut banks, &payer, &[], &[ix_update_btc_header(&h1_prime)])
        .await
        .expect_err("reorg attempt must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::HeaderChainDiscontinuous as u32),
        "expected HeaderChainDiscontinuous, got {err:?}"
    );

    // Chain tip must still be H1 — a rejected reorg cannot have written
    // any state.
    let chain = fetch_header_chain(&mut banks).await;
    assert_eq!(chain.latest_hash, h1_hash);
    assert_eq!(chain.latest_height, 800_001);

    // And a genuine extension on top of H1 still works.
    let h2 = mine_regtest_header(h1_hash, [0xa3u8; 32], 1_700_001_200);
    send(&mut banks, &payer, &[], &[ix_update_btc_header(&h2)])
        .await
        .expect("extension on top of the surviving tip should succeed");
}

// --- 8b. double payment same invoice -------------------------------------

#[tokio::test]
async fn btc_spv_part_1_on_swept_invoice_is_rejected() {
    // The Solana settlement rail flips an invoice Open → Swept. After
    // that, opening a BTC SPV proof would be a second settlement against
    // the same invoice — the program rejects with `InvoiceAlreadyPaid`
    // before any proof account gets created. This is the on-chain guard
    // the off-chain webhook dispatcher relies on so a retry race cannot
    // record two settlements for one invoice.
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![0])],
    )
    .await
    .unwrap();

    let (invoice_pda, _) = find_invoice_pda(&master.pubkey(), 0, &program_id());
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_submit_btc_proof_part_1(
            &invoice_pda,
            &master.pubkey(),
            &payer.pubkey(),
            vec![0xde, 0xad, 0xbe, 0xef],
            vec![],
            0,
        )],
    )
    .await
    .expect_err("BTC SPV proof on swept invoice must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::InvoiceAlreadyPaid as u32),
        "expected InvoiceAlreadyPaid, got {err:?}"
    );

    // Invoice must remain Swept — the rejected proof cannot have created
    // an SPV proof account or shifted the invoice status.
    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.status, INVOICE_STATUS_SWEPT);
}

#[tokio::test]
async fn eth_spv_part_1_on_swept_invoice_is_rejected() {
    // Mirror of `btc_spv_part_1_on_swept_invoice_is_rejected` for the
    // Ethereum receipt rail. Same defense — a terminated invoice cannot
    // accept a new settlement proof, regardless of which chain the
    // settlement claims to come from.
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![0])],
    )
    .await
    .unwrap();

    let (invoice_pda, _) = find_invoice_pda(&master.pubkey(), 0, &program_id());
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_submit_eth_receipt_part_1(
            &invoice_pda,
            &master.pubkey(),
            &payer.pubkey(),
        )],
    )
    .await
    .expect_err("ETH SPV proof on swept invoice must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::InvoiceAlreadyPaid as u32),
        "expected InvoiceAlreadyPaid, got {err:?}"
    );
}

// --- 8c. sweep with invalid invoice_ids ---------------------------------

#[tokio::test]
async fn sweep_with_uninitialised_invoice_pda_is_rejected() {
    // Caller passes a non-zero invoice index whose PDA was never
    // initialised. The account is still system-owned, so the
    // `assert_owned_by_program` check fires before any deserialization.
    // The error surfaces as `IllegalOwner` from solana_program — distinct
    // from any `ZpError::*` custom code, which is exactly the signal an
    // off-chain monitor uses to alert on "caller bug, not protocol bug".
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();

    // Index 99 has no on-chain invoice; the PDA derivation still yields a
    // valid address but the account is uninitialised (system-owned).
    let err = send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_sweep(&master.pubkey(), &master.pubkey(), vec![99])],
    )
    .await
    .expect_err("sweep against uninitialised invoice PDA must be rejected");
    // No custom code — the bare ProgramError::IllegalOwner shows up as a
    // non-Custom InstructionError. The exact discriminator is left
    // unchecked because Banks may collapse the wrapper across versions;
    // the contract we care about here is "does NOT succeed and does NOT
    // surface a ZpError custom code".
    assert!(extract_custom(&err).is_none(), "expected non-custom error, got {err:?}");
    assert!(
        matches!(err, TransactionError::InstructionError(_, _)),
        "expected an instruction error, got {err:?}"
    );

    // The legitimate invoice 0 must remain Open — a rejected sweep cannot
    // partially apply.
    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.status, INVOICE_STATUS_OPEN);
}

#[tokio::test]
async fn sweep_with_foreign_merchant_invoice_pda_is_rejected() {
    // Two merchants register independently. Caller tries to sweep with a
    // sweep payload that names index 0 on merchant A's call, but supplies
    // merchant B's invoice PDA as the per-index account. The PDA-seed
    // recomputation against merchant A's master rejects the wrong address
    // with `InvoicePdaMismatch`.
    let (mut banks, payer, _) = program_test().start().await;
    let master_a = Keypair::new();
    let master_b = Keypair::new();

    init_default_config(&mut banks, &payer).await;
    for m in [&master_a, &master_b] {
        send(
            &mut banks,
            &payer,
            &[m],
            &[ix_register_merchant(
                &m.pubkey(),
                &payer.pubkey(),
                vec![CHAIN_SOLANA],
            )],
        )
        .await
        .unwrap();
        send(
            &mut banks,
            &payer,
            &[m],
            &[ix_create_invoice(
                &m.pubkey(),
                &payer.pubkey(),
                0,
                1_000_000,
                CURRENCY_USDC,
            )],
        )
        .await
        .unwrap();
    }

    // Hand-build the sweep instruction so the merchant + signer reference
    // master_a, but the per-index account is master_b's invoice PDA.
    let (merchant_a_pda, _) = find_merchant_pda(&master_a.pubkey(), &program_id());
    let (foreign_invoice_pda, _) = find_invoice_pda(&master_b.pubkey(), 0, &program_id());
    let args = SweepArgs {
        invoice_indexes: vec![0],
    };
    let mut data = vec![InstructionTag::Sweep as u8];
    args.serialize(&mut data).unwrap();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(merchant_a_pda, false),
            AccountMeta::new_readonly(master_a.pubkey(), true),
            AccountMeta::new(foreign_invoice_pda, false),
        ],
        data,
    };

    let err = send(&mut banks, &payer, &[&master_a], &[ix])
        .await
        .expect_err("cross-merchant sweep must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::InvoicePdaMismatch as u32),
        "expected InvoicePdaMismatch, got {err:?}"
    );

    // Both merchants' invoices stay Open.
    let a = fetch_invoice(&mut banks, &master_a.pubkey(), 0).await;
    let b = fetch_invoice(&mut banks, &master_b.pubkey(), 0).await;
    assert_eq!(a.status, INVOICE_STATUS_OPEN);
    assert_eq!(b.status, INVOICE_STATUS_OPEN);
}

#[tokio::test]
async fn sweep_with_index_account_count_mismatch_is_rejected() {
    // Caller supplies two indexes but only one invoice account. The
    // length-mismatch guard (`AccountInvoiceCountMismatch`) fires before
    // any PDA recomputation — protecting against silent skips where the
    // off-chain ledger would credit settlements that never happened.
    let (mut banks, payer, _) = program_test().start().await;
    let master = Keypair::new();

    init_default_config(&mut banks, &payer).await;
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_register_merchant(
            &master.pubkey(),
            &payer.pubkey(),
            vec![CHAIN_SOLANA],
        )],
    )
    .await
    .unwrap();
    send(
        &mut banks,
        &payer,
        &[&master],
        &[ix_create_invoice(
            &master.pubkey(),
            &payer.pubkey(),
            0,
            1_000_000,
            CURRENCY_USDC,
        )],
    )
    .await
    .unwrap();

    // Hand-build a sweep with two indexes but only one account.
    let (merchant_pda, _) = find_merchant_pda(&master.pubkey(), &program_id());
    let (invoice_0_pda, _) = find_invoice_pda(&master.pubkey(), 0, &program_id());
    let args = SweepArgs {
        invoice_indexes: vec![0, 1],
    };
    let mut data = vec![InstructionTag::Sweep as u8];
    args.serialize(&mut data).unwrap();
    let ix = Instruction {
        program_id: program_id(),
        accounts: vec![
            AccountMeta::new(merchant_pda, false),
            AccountMeta::new_readonly(master.pubkey(), true),
            AccountMeta::new(invoice_0_pda, false),
        ],
        data,
    };

    let err = send(&mut banks, &payer, &[&master], &[ix])
        .await
        .expect_err("count mismatch must be rejected");
    assert_eq!(
        extract_custom(&err),
        Some(ZpError::AccountInvoiceCountMismatch as u32),
        "expected AccountInvoiceCountMismatch, got {err:?}"
    );

    let inv = fetch_invoice(&mut banks, &master.pubkey(), 0).await;
    assert_eq!(inv.status, INVOICE_STATUS_OPEN);
}
