//! ZettaPay merchant binding program.
//!
//! Single instruction `register_merchant` writes an immutable
//! `MerchantBinding` PDA derived from `[merchant_handle, owner]`.
//! There is intentionally no update or close instruction: once the binding
//! exists on-chain it cannot be mutated by any signer, including the owner.

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

#[event]
pub struct MerchantRegistered {
    pub owner: Pubkey,
    pub merchant_handle: String,
    pub usdc_token_account: Pubkey,
    pub registered_at: i64,
}

#[error_code]
pub enum ZettaPayError {
    #[msg("Merchant handle must be between 3 and 32 bytes inclusive")]
    HandleLengthInvalid,
    #[msg("Merchant handle must be lowercase ASCII alphanumerics with - or _, and must start with an alphanumeric")]
    HandleCharsInvalid,
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
}
