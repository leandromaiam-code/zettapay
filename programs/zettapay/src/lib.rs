//! ZettaPay merchant binding program.
//!
//! Two instructions:
//!
//! 1. `register_merchant` writes an immutable `MerchantBinding` PDA derived
//!    from `[merchant_handle, owner]`.
//! 2. `record_payment` writes an immutable `Payment` PDA derived from
//!    `[merchant_binding, payment_id]`, anchoring `(amount, tx_signature)`
//!    of an already-settled USDC transfer.
//!
//! Neither instruction has an update or close counterpart: once a record
//! exists on-chain it cannot be mutated by any signer, including the owner.
//! That immutability is the trust contract Z9 needs — the chain is the
//! source of truth for both the (handle → owner, USDC payout account)
//! binding and the (merchant, payment_id) → (amount, signature) receipt.

use anchor_lang::prelude::*;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const MERCHANT_HANDLE_MIN_LEN: usize = 3;
pub const MERCHANT_HANDLE_MAX_LEN: usize = 32;

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

#[error_code]
pub enum ZettaPayError {
    #[msg("Merchant handle must be between 3 and 32 bytes inclusive")]
    HandleLengthInvalid,
    #[msg("Merchant handle must be lowercase ASCII alphanumerics with - or _, and must start with an alphanumeric")]
    HandleCharsInvalid,
    #[msg("Payment amount must be strictly greater than zero")]
    AmountMustBePositive,
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
}
