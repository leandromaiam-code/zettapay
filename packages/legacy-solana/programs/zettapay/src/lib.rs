//! ZettaPay merchant binding program.
//!
//! Instructions:
//!
//! 1. `register_merchant` writes an immutable `MerchantBinding` PDA derived
//!    from `[merchant_handle, owner]`.
//! 2. `record_payment` writes an immutable `Payment` PDA derived from
//!    `[merchant_binding, payment_id]`, anchoring `(amount, tx_signature)`
//!    of an already-settled USDC transfer.
//! 3. `init_settings` writes a singleton `Settings` PDA at `[b"settings"]`
//!    holding the protocol fee config: `admin`, `fee_bps`, `treasury`.
//! 4. `set_fee_bps` updates `Settings.fee_bps` (admin signer required).
//! 5. `settle_payment` writes an immutable `SettlementReceipt` PDA that
//!    commits the protocol fee split on-chain: `fee_amount` to the
//!    protocol treasury and `merchant_amount` to the merchant. The
//!    receipt anchors the `tx_signature` of the customer-signed USDC
//!    transfer(s) that performed the actual on-chain movement — premise
//!    14 (no custody) is preserved: the program never holds USDC, only
//!    records and commits to the split derived from `Settings.fee_bps`.
//!
//! Neither `register_merchant`, `record_payment`, nor `settle_payment` has
//! an update or close counterpart: once a record exists on-chain it cannot
//! be mutated by any signer, including the owner or the admin. Only
//! `set_fee_bps` mutates state — and exclusively the `fee_bps` field of
//! `Settings`, gated on the recorded admin. Immutability is the trust
//! contract Z9 needs.
//!
//! Premise alignment (Layer 0):
//! * #14 (no custody)  — `settle_payment` records the commitment; the
//!                       customer's signed USDC transfer is what actually
//!                       moves tokens. The program never holds funds.
//! * #20 (0.30% fees)  — `INIT_FEE_BPS = 30` and `MAX_FEE_BPS = 100` cap
//!                       the protocol fee at 10x cheaper than Stripe's
//!                       2.9%; `set_fee_bps` cannot exceed 100bps.

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MERCHANT_HANDLE_MIN_LEN: usize = 3;
pub const MERCHANT_HANDLE_MAX_LEN: usize = 32;

/// Protocol fee in basis points (1bp = 0.01%). 30bps = 0.30% — Layer-0
/// premise #20, "fees 10x cheaper than Stripe 2.9%".
pub const INIT_FEE_BPS: u16 = 30;

/// Hard cap on the protocol fee. 100bps = 1.00%. Layer-0 premise #20
/// puts the moat at 10x cheaper than Stripe; the cap prevents an
/// admin-key compromise from raising fees beyond the protocol promise.
pub const MAX_FEE_BPS: u16 = 100;

/// Basis-point denominator. `fee_amount = amount * fee_bps / BPS_DENOM`.
pub const BPS_DENOM: u64 = 10_000;

#[program]
pub mod zettapay {
    use super::*;

    pub fn register_merchant(
        ctx: Context<RegisterMerchant>,
        merchant_handle: String,
        usdc_token_account: Pubkey,
    ) -> Result<()> {
        require!(
            (MERCHANT_HANDLE_MIN_LEN..=MERCHANT_HANDLE_MAX_LEN).contains(&merchant_handle.len()),
            ZettaPayError::HandleLengthInvalid
        );
        require!(
            handle_chars_valid(&merchant_handle),
            ZettaPayError::HandleCharsInvalid
        );

        let binding = &mut ctx.accounts.binding;
        binding.bump = ctx.bumps.binding;
        binding.owner = ctx.accounts.owner.key();
        binding.usdc_token_account = usdc_token_account;
        binding.merchant_handle = merchant_handle;
        binding.registered_at = Clock::get()?.unix_timestamp;

        emit!(MerchantRegistered {
            owner: binding.owner,
            merchant_handle: binding.merchant_handle.clone(),
            usdc_token_account: binding.usdc_token_account,
            registered_at: binding.registered_at,
        });

        Ok(())
    }

    pub fn record_payment(
        ctx: Context<RecordPayment>,
        payment_id: [u8; 32],
        amount: u64,
        tx_signature: [u8; 64],
    ) -> Result<()> {
        require!(amount > 0, ZettaPayError::AmountMustBePositive);

        let payment = &mut ctx.accounts.payment;
        payment.bump = ctx.bumps.payment;
        payment.merchant_binding = ctx.accounts.merchant_binding.key();
        payment.payment_id = payment_id;
        payment.amount = amount;
        payment.tx_signature = tx_signature;
        payment.recorded_at = Clock::get()?.unix_timestamp;

        emit!(PaymentRecorded {
            merchant_binding: payment.merchant_binding,
            payment_id,
            amount,
            tx_signature,
            recorded_at: payment.recorded_at,
        });

        Ok(())
    }

    /// Bootstrap the singleton `Settings` PDA. Idempotency comes from
    /// Anchor's `init` constraint: a second invocation against the same
    /// settings PDA fails with "account already in use".
    pub fn init_settings(ctx: Context<InitSettings>, treasury: Pubkey) -> Result<()> {
        let settings = &mut ctx.accounts.settings;
        settings.bump = ctx.bumps.settings;
        settings.admin = ctx.accounts.admin.key();
        settings.fee_bps = INIT_FEE_BPS;
        settings.treasury = treasury;

        emit!(SettingsInitialized {
            admin: settings.admin,
            fee_bps: settings.fee_bps,
            treasury: settings.treasury,
        });

        Ok(())
    }

    /// Admin-only mutation of the protocol fee. Hard-capped at
    /// `MAX_FEE_BPS` so an admin-key compromise cannot raise the fee
    /// beyond the protocol promise (premise #20).
    pub fn set_fee_bps(ctx: Context<SetFeeBps>, new_fee_bps: u16) -> Result<()> {
        require!(
            new_fee_bps <= MAX_FEE_BPS,
            ZettaPayError::FeeBpsExceedsMax
        );

        let settings = &mut ctx.accounts.settings;
        let old = settings.fee_bps;
        settings.fee_bps = new_fee_bps;

        emit!(FeeBpsUpdated {
            admin: settings.admin,
            old_fee_bps: old,
            new_fee_bps,
        });

        Ok(())
    }

    /// Anchor an immutable settlement receipt for a customer-signed USDC
    /// transfer that performed the protocol-fee split off-chain (or as
    /// SPL Token instructions in the same client-built transaction).
    ///
    /// The program does not move USDC — premise #14 forbids custody.
    /// What it does commit to:
    ///
    ///   fee_amount      = amount * settings.fee_bps / 10_000
    ///   merchant_amount = amount - fee_amount
    ///
    /// Together with the recorded `treasury` and `merchant_binding`, the
    /// receipt is a cryptographically anchored proof that the split was
    /// computed from the current `Settings.fee_bps` at settlement time.
    /// Off-chain indexers verify the customer's `tx_signature` deposited
    /// exactly `fee_amount` into `treasury` and `merchant_amount` into
    /// the merchant's USDC ATA; a mismatch is publicly auditable.
    pub fn settle_payment(
        ctx: Context<SettlePayment>,
        payment_id: [u8; 32],
        amount: u64,
        tx_signature: [u8; 64],
    ) -> Result<()> {
        require!(amount > 0, ZettaPayError::AmountMustBePositive);

        let settings = &ctx.accounts.settings;
        // Belt-and-suspenders: even though `set_fee_bps` clamps, re-check
        // here so a corrupted `Settings` account can't silently apply an
        // over-cap fee at settlement.
        require!(
            settings.fee_bps <= MAX_FEE_BPS,
            ZettaPayError::FeeBpsExceedsMax
        );

        let (fee_amount, merchant_amount) = compute_split(amount, settings.fee_bps)?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.bump = ctx.bumps.receipt;
        receipt.merchant_binding = ctx.accounts.merchant_binding.key();
        receipt.payment_id = payment_id;
        receipt.amount = amount;
        receipt.fee_amount = fee_amount;
        receipt.merchant_amount = merchant_amount;
        receipt.fee_bps_applied = settings.fee_bps;
        receipt.treasury = settings.treasury;
        receipt.tx_signature = tx_signature;
        receipt.settled_at = Clock::get()?.unix_timestamp;

        emit!(PaymentSettled {
            merchant_binding: receipt.merchant_binding,
            payment_id,
            amount,
            fee_amount,
            merchant_amount,
            fee_bps_applied: receipt.fee_bps_applied,
            treasury: receipt.treasury,
            tx_signature,
            settled_at: receipt.settled_at,
        });

        Ok(())
    }
}

fn handle_chars_valid(handle: &str) -> bool {
    let mut bytes = handle.bytes();
    let Some(first) = bytes.next() else {
        return false;
    };
    if !matches!(first, b'a'..=b'z' | b'0'..=b'9') {
        return false;
    }
    bytes.all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

/// Deterministic protocol-fee split. Extracted so the math has its own
/// unit-test surface and `settle_payment`'s handler stays readable. Uses
/// `checked_*` arithmetic throughout — the workspace release profile
/// enables overflow-checks, but the Rust optimiser may elide them under
/// LTO; explicit checks make the safety property local instead of relying
/// on a build-profile invariant.
fn compute_split(amount: u64, fee_bps: u16) -> Result<(u64, u64)> {
    let fee_amount = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(ZettaPayError::FeeAmountOverflow)?
        .checked_div(BPS_DENOM as u128)
        .ok_or(ZettaPayError::FeeAmountOverflow)?;
    // `fee_bps <= MAX_FEE_BPS <= 100` and `amount <= u64::MAX`, so
    // `fee_amount = amount * fee_bps / 10_000` is always strictly less
    // than `amount` for non-zero amount and fits in u64. The fallible
    // cast and subtraction are still expressed via checked ops so a
    // future cap change (e.g. raising MAX_FEE_BPS above 10_000) cannot
    // silently produce a negative merchant_amount.
    let fee_amount_u64: u64 = u64::try_from(fee_amount)
        .map_err(|_| ZettaPayError::FeeAmountOverflow)?;
    let merchant_amount = amount
        .checked_sub(fee_amount_u64)
        .ok_or(ZettaPayError::FeeAmountOverflow)?;
    Ok((fee_amount_u64, merchant_amount))
}

#[derive(Accounts)]
#[instruction(merchant_handle: String)]
pub struct RegisterMerchant<'info> {
    /// Immutable merchant binding PDA. `init` rejects re-registration of the
    /// same `(merchant_handle, owner)` pair, which is exactly the on-chain
    /// uniqueness guarantee Z9 requires.
    #[account(
        init,
        payer = payer,
        space = MerchantBinding::SIZE,
        seeds = [merchant_handle.as_bytes(), owner.key().as_ref()],
        bump,
    )]
    pub binding: Account<'info, MerchantBinding>,

    /// The merchant identity. Must sign so a third party cannot bind a handle
    /// to a wallet they do not control.
    pub owner: Signer<'info>,

    /// Rent payer. Decoupled from `owner` so a facilitator can sponsor the
    /// account creation without holding any authority over the binding.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct RecordPayment<'info> {
    /// The merchant this payment was settled to. Anchor's
    /// `Account<'info, MerchantBinding>` enforces the discriminator, so an
    /// arbitrary unrelated account cannot stand in for a binding.
    pub merchant_binding: Account<'info, MerchantBinding>,

    /// Immutable payment receipt PDA. `init` rejects re-recording of the
    /// same `(merchant_binding, payment_id)` pair — that's the on-chain
    /// idempotency guarantee Z9 requires for receipts.
    #[account(
        init,
        payer = payer,
        space = Payment::SIZE,
        seeds = [merchant_binding.key().as_ref(), &payment_id],
        bump,
    )]
    pub payment: Account<'info, Payment>,

    /// Rent payer. Recording a payment receipt is intentionally
    /// permissionless: any facilitator (including the merchant itself or an
    /// AI agent) can anchor a settled transfer without needing the
    /// `merchant_binding.owner` to sign. The receipt is a proof, not an
    /// authorisation.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitSettings<'info> {
    /// Singleton `Settings` PDA. The `seeds = [b"settings"]` derivation
    /// makes the account globally unique per program ID — a second
    /// `init_settings` invocation hits Anchor's "account already in use"
    /// reject path, which is exactly the one-shot bootstrap guarantee we
    /// want.
    #[account(
        init,
        payer = payer,
        space = Settings::SIZE,
        seeds = [b"settings"],
        bump,
    )]
    pub settings: Account<'info, Settings>,

    /// The protocol admin. Must sign to claim that authority — no third
    /// party can install themselves as admin during bootstrap.
    pub admin: Signer<'info>,

    /// Rent payer. Decoupled from `admin` so a facilitator can sponsor
    /// the deployment without inheriting administrative rights.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetFeeBps<'info> {
    /// `has_one = admin` enforces the authority check at the Anchor
    /// constraint layer: the supplied `admin` signer must match the
    /// admin pubkey recorded at `init_settings` time. No third party
    /// who happens to know the settings PDA can adjust the fee.
    ///
    /// `bump` (no rhs) forces Anchor to re-derive the canonical bump
    /// rather than trust a caller-supplied value, satisfying the
    /// Soteria bump-seed-canonicalization check (X-007).
    #[account(
        mut,
        seeds = [b"settings"],
        bump,
        has_one = admin @ ZettaPayError::Unauthorized,
    )]
    pub settings: Account<'info, Settings>,

    pub admin: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(payment_id: [u8; 32])]
pub struct SettlePayment<'info> {
    /// Read-only view of the current fee config. The settings PDA seed
    /// constraint guarantees we're reading the canonical singleton.
    /// `bump` (no rhs) forces canonical-bump re-derivation (X-007).
    #[account(
        seeds = [b"settings"],
        bump,
    )]
    pub settings: Account<'info, Settings>,

    /// The merchant this settlement credits. Discriminator-checked.
    pub merchant_binding: Account<'info, MerchantBinding>,

    /// Immutable settlement receipt PDA. The seed pair
    /// `[merchant_binding, payment_id]` is intentionally the same as
    /// `RecordPayment` so off-chain indexers can scan both account
    /// types under a unified `(merchant, payment_id)` key — Anchor's
    /// discriminator distinguishes them, so the address space is
    /// effectively disjoint per account type.
    #[account(
        init,
        payer = payer,
        space = SettlementReceipt::SIZE,
        seeds = [b"settle", merchant_binding.key().as_ref(), &payment_id],
        bump,
    )]
    pub receipt: Account<'info, SettlementReceipt>,

    /// Rent payer. Permissionless settlement recording mirrors
    /// `record_payment`'s design: any facilitator can anchor the split
    /// commitment. The receipt is a proof, not an authorisation.
    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct MerchantBinding {
    pub bump: u8,
    pub owner: Pubkey,
    pub usdc_token_account: Pubkey,
    pub merchant_handle: String,
    pub registered_at: i64,
}

impl MerchantBinding {
    pub const SIZE: usize = 8  // anchor account discriminator
        + 1                    // bump
        + 32                   // owner
        + 32                   // usdc_token_account
        + 4 + MERCHANT_HANDLE_MAX_LEN  // borsh string: u32 len + bytes
        + 8;                   // registered_at
}

#[account]
pub struct Payment {
    pub bump: u8,
    pub merchant_binding: Pubkey,
    pub payment_id: [u8; 32],
    pub amount: u64,
    pub tx_signature: [u8; 64],
    pub recorded_at: i64,
}

impl Payment {
    pub const SIZE: usize = 8  // anchor account discriminator
        + 1                    // bump
        + 32                   // merchant_binding
        + 32                   // payment_id
        + 8                    // amount
        + 64                   // tx_signature
        + 8;                   // recorded_at
}

#[account]
pub struct Settings {
    pub bump: u8,
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub treasury: Pubkey,
}

impl Settings {
    pub const SIZE: usize = 8  // anchor account discriminator
        + 1                    // bump
        + 32                   // admin
        + 2                    // fee_bps
        + 32;                  // treasury
}

#[account]
pub struct SettlementReceipt {
    pub bump: u8,
    pub merchant_binding: Pubkey,
    pub payment_id: [u8; 32],
    pub amount: u64,
    pub fee_amount: u64,
    pub merchant_amount: u64,
    pub fee_bps_applied: u16,
    pub treasury: Pubkey,
    pub tx_signature: [u8; 64],
    pub settled_at: i64,
}

impl SettlementReceipt {
    pub const SIZE: usize = 8  // anchor account discriminator
        + 1                    // bump
        + 32                   // merchant_binding
        + 32                   // payment_id
        + 8                    // amount
        + 8                    // fee_amount
        + 8                    // merchant_amount
        + 2                    // fee_bps_applied
        + 32                   // treasury
        + 64                   // tx_signature
        + 8;                   // settled_at
}

#[event]
pub struct MerchantRegistered {
    pub owner: Pubkey,
    pub merchant_handle: String,
    pub usdc_token_account: Pubkey,
    pub registered_at: i64,
}

#[event]
pub struct PaymentRecorded {
    pub merchant_binding: Pubkey,
    pub payment_id: [u8; 32],
    pub amount: u64,
    pub tx_signature: [u8; 64],
    pub recorded_at: i64,
}

#[event]
pub struct SettingsInitialized {
    pub admin: Pubkey,
    pub fee_bps: u16,
    pub treasury: Pubkey,
}

#[event]
pub struct FeeBpsUpdated {
    pub admin: Pubkey,
    pub old_fee_bps: u16,
    pub new_fee_bps: u16,
}

#[event]
pub struct PaymentSettled {
    pub merchant_binding: Pubkey,
    pub payment_id: [u8; 32],
    pub amount: u64,
    pub fee_amount: u64,
    pub merchant_amount: u64,
    pub fee_bps_applied: u16,
    pub treasury: Pubkey,
    pub tx_signature: [u8; 64],
    pub settled_at: i64,
}

#[error_code]
pub enum ZettaPayError {
    #[msg("Merchant handle must be between 3 and 32 bytes inclusive")]
    HandleLengthInvalid,
    #[msg("Merchant handle must be lowercase ASCII alphanumerics with - or _, and must start with an alphanumeric")]
    HandleCharsInvalid,
    #[msg("Payment amount must be strictly greater than zero")]
    AmountMustBePositive,
    #[msg("Protocol fee in basis points exceeds the hard cap of 100 (1.00%)")]
    FeeBpsExceedsMax,
    #[msg("Protocol fee arithmetic overflow")]
    FeeAmountOverflow,
    #[msg("Caller is not the recorded protocol admin")]
    Unauthorized,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_handles() {
        assert!(handle_chars_valid("acme"));
        assert!(handle_chars_valid("acme-store"));
        assert!(handle_chars_valid("acme_store_42"));
        assert!(handle_chars_valid("0xfoo"));
    }

    #[test]
    fn rejects_invalid_handles() {
        assert!(!handle_chars_valid(""));
        assert!(!handle_chars_valid("ACME"));
        assert!(!handle_chars_valid("-acme"));
        assert!(!handle_chars_valid("acme.store"));
        assert!(!handle_chars_valid("acme store"));
    }

    #[test]
    fn binding_size_within_pda_max() {
        // Solana caps account size at 10 KiB for PDA `init`. Sanity check that
        // we're well under that ceiling so handle-length tweaks don't silently
        // overflow rent calculations.
        assert!(MerchantBinding::SIZE < 10_000);
    }

    #[test]
    fn payment_size_within_pda_max() {
        assert!(Payment::SIZE < 10_000);
    }

    #[test]
    fn payment_size_matches_field_layout() {
        // Pin the layout so adding/removing a field in `Payment` without
        // updating `SIZE` (and therefore rent) trips this test instead of
        // shipping under-funded accounts to mainnet.
        assert_eq!(Payment::SIZE, 8 + 1 + 32 + 32 + 8 + 64 + 8);
    }

    #[test]
    fn settings_size_matches_field_layout() {
        assert_eq!(Settings::SIZE, 8 + 1 + 32 + 2 + 32);
        assert!(Settings::SIZE < 10_000);
    }

    #[test]
    fn settlement_receipt_size_matches_field_layout() {
        assert_eq!(
            SettlementReceipt::SIZE,
            8 + 1 + 32 + 32 + 8 + 8 + 8 + 2 + 32 + 64 + 8
        );
        assert!(SettlementReceipt::SIZE < 10_000);
    }

    #[test]
    fn init_fee_bps_is_0_30_percent() {
        // Layer-0 premise #20: "fees 10x cheaper than Stripe 2.9%". The
        // protocol's default of 30bps = 0.30% pins that contract — if a
        // future refactor moves the constant the test trips.
        assert_eq!(INIT_FEE_BPS, 30);
    }

    #[test]
    fn max_fee_bps_caps_at_one_percent() {
        // The cap is the runtime enforcement of premise #20: even an
        // admin-key compromise cannot raise fees above 1.00%, keeping
        // the protocol an order of magnitude below Stripe.
        assert_eq!(MAX_FEE_BPS, 100);
        assert!(INIT_FEE_BPS <= MAX_FEE_BPS);
    }

    // ---- compute_split ---------------------------------------------------

    #[test]
    fn split_default_fee_30bps() {
        // 1,000,000 USDC base units (= 1 USDC) at 0.30% → 3,000 fee
        // base units, 997,000 to merchant.
        let (fee, merch) = compute_split(1_000_000, INIT_FEE_BPS).unwrap();
        assert_eq!(fee, 3_000);
        assert_eq!(merch, 997_000);
        assert_eq!(fee + merch, 1_000_000);
    }

    #[test]
    fn split_round_amount_at_default_fee() {
        // 100 USDC = 100,000,000 base units. 0.30% = 300,000 base units
        // (= $0.30) — the canonical worked example in the pricing copy.
        let (fee, merch) = compute_split(100_000_000, INIT_FEE_BPS).unwrap();
        assert_eq!(fee, 300_000);
        assert_eq!(merch, 99_700_000);
    }

    #[test]
    fn split_fee_zero_sends_full_amount_to_merchant() {
        // Edge: a future governance vote could drop the fee to zero
        // (e.g. promotional period). The math must still produce a
        // valid receipt — no division-by-zero on the BPS_DENOM side.
        let (fee, merch) = compute_split(1_000_000, 0).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(merch, 1_000_000);
    }

    #[test]
    fn split_fee_at_max_cap_100bps() {
        // Edge: fee at the hard cap of 1.00%. 1,000,000 base units →
        // 10,000 fee, 990,000 merchant.
        let (fee, merch) = compute_split(1_000_000, MAX_FEE_BPS).unwrap();
        assert_eq!(fee, 10_000);
        assert_eq!(merch, 990_000);
        assert_eq!(fee + merch, 1_000_000);
    }

    #[test]
    fn split_invariant_fee_plus_merchant_equals_amount() {
        // Pin the invariant across a range of amounts and fees. Any
        // refactor that broke the integer-truncation choice (e.g. by
        // rounding fee up) would trip this — `fee + merch == amount`
        // is the load-bearing accounting property.
        for amount in [1_u64, 7, 999, 1_000_000, 1_234_567_890] {
            for &bps in &[0_u16, 1, 30, 50, 99, MAX_FEE_BPS] {
                let (fee, merch) = compute_split(amount, bps).unwrap();
                assert_eq!(
                    fee.checked_add(merch).unwrap(),
                    amount,
                    "amount={amount} bps={bps}"
                );
                // Sanity bound: fee never exceeds amount.
                assert!(fee <= amount, "amount={amount} bps={bps}");
            }
        }
    }

    #[test]
    fn split_small_amount_truncates_fee_to_zero() {
        // Edge: tiny amounts where `amount * fee_bps < 10_000`. At
        // 30bps a $0.000033 payment rounds the fee to zero (integer
        // truncation is the canonical choice — receipts always favour
        // the merchant by at most 1 base unit, never the protocol).
        let (fee, merch) = compute_split(33, 30).unwrap();
        assert_eq!(fee, 0);
        assert_eq!(merch, 33);
    }

    #[test]
    fn split_handles_u64_max_without_overflow() {
        // Edge: the intermediate `amount * fee_bps` would overflow u64
        // for amount near `u64::MAX`. Promoting to u128 inside
        // `compute_split` keeps the math safe; pin the property with
        // the worst-case input. Result still fits in u64 because
        // `fee_bps <= 100`, so `amount * 100 / 10_000 = amount / 100`.
        let (fee, merch) = compute_split(u64::MAX, MAX_FEE_BPS).unwrap();
        assert_eq!(fee, u64::MAX / 100);
        assert_eq!(merch, u64::MAX - fee);
    }
}
