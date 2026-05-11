//! Manual account validation helpers — replace what Anchor's `#[account]`
//! macro would generate.
//!
//! Each instruction handler composes these to enforce:
//!
//!   * owner check  — the account was previously written by this program
//!     (rejects an attacker-supplied look-alike account).
//!   * signer check — the wallet authorised this transaction (rejects a
//!     replay where a third party tries to act as the merchant).
//!   * system-program check — the account passed for the system program
//!     really is the system program (rejects swap-in attacks where
//!     `create_account` would CPI into the wrong program).
//!   * tag check    — the first byte of an owned account's data matches
//!     the expected account type, before any Borsh deserialization.
//!
//! PDA seed checks are intentionally left at the call site so that
//! merchant-vs-invoice address mismatches surface with their precise
//! `ZpError::MerchantPdaMismatch` / `ZpError::InvoicePdaMismatch` codes —
//! a wrapped helper would have to collapse them into one variant.

use solana_program::{
    account_info::AccountInfo,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_program,
};

use crate::error::ZpError;
use crate::state::{INVOICE_TAG, MERCHANT_TAG};

/// Assert that `account` is owned by `program_id`. Required before
/// deserializing state — an account not owned by us is not state we wrote,
/// and trusting its bytes is the canonical "fake account" exploit.
pub fn assert_owned_by_program(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    if account.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    Ok(())
}

/// Assert that `account.is_signer` is true. Used for any account whose
/// authority the instruction relies on — typically the merchant's master
/// wallet and the rent payer.
pub fn assert_signer(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

/// Assert that the supplied account is the canonical system program.
/// Required before `invoke_signed(create_account(...))` so an attacker
/// cannot route the CPI into a look-alike program.
pub fn assert_system_program(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// Assert that the first byte of an owned account's data matches
/// `expected_tag`. Cheaper than a full Borsh deserialize when the caller
/// only wants to confirm the account *type*.
pub fn assert_tag(account: &AccountInfo, expected_tag: u8) -> Result<(), ProgramError> {
    let data = account.data.borrow();
    let first = data.first().copied().ok_or(ZpError::InvalidInstruction)?;
    if first != expected_tag {
        let err = match expected_tag {
            MERCHANT_TAG => ZpError::NotMerchantAccount,
            INVOICE_TAG => ZpError::NotInvoiceAccount,
            _ => ZpError::InvalidInstruction,
        };
        return Err(err.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::clock::Epoch;

    fn fixed_program_id() -> Pubkey {
        Pubkey::new_from_array([42u8; 32])
    }

    fn make_account_info<'a>(
        key: &'a Pubkey,
        is_signer: bool,
        lamports: &'a mut u64,
        data: &'a mut [u8],
        owner: &'a Pubkey,
    ) -> AccountInfo<'a> {
        AccountInfo::new(
            key,
            is_signer,
            true,
            lamports,
            data,
            owner,
            false,
            Epoch::default(),
        )
    }

    #[test]
    fn assert_owned_by_program_accepts_matching_owner() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data = vec![0u8; 8];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &program_id);
        assert!(assert_owned_by_program(&acc, &program_id).is_ok());
    }

    #[test]
    fn assert_owned_by_program_rejects_foreign_owner() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let foreign = Pubkey::new_from_array([99u8; 32]);
        let mut lamports = 0u64;
        let mut data = vec![0u8; 8];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &foreign);
        let err = assert_owned_by_program(&acc, &program_id).unwrap_err();
        assert_eq!(err, ProgramError::IllegalOwner);
    }

    #[test]
    fn assert_signer_accepts_signer() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data = vec![0u8; 0];
        let acc = make_account_info(&key, true, &mut lamports, &mut data, &program_id);
        assert!(assert_signer(&acc).is_ok());
    }

    #[test]
    fn assert_signer_rejects_non_signer() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data = vec![0u8; 0];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &program_id);
        let err = assert_signer(&acc).unwrap_err();
        assert_eq!(err, ProgramError::MissingRequiredSignature);
    }

    #[test]
    fn assert_system_program_accepts_canonical_id() {
        let key = system_program::ID;
        let owner = Pubkey::new_from_array([0u8; 32]);
        let mut lamports = 0u64;
        let mut data = vec![0u8; 0];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &owner);
        assert!(assert_system_program(&acc).is_ok());
    }

    #[test]
    fn assert_system_program_rejects_other_program_id() {
        let key = Pubkey::new_from_array([7u8; 32]);
        let owner = Pubkey::new_from_array([0u8; 32]);
        let mut lamports = 0u64;
        let mut data = vec![0u8; 0];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &owner);
        let err = assert_system_program(&acc).unwrap_err();
        assert_eq!(err, ProgramError::IncorrectProgramId);
    }

    #[test]
    fn assert_tag_accepts_matching_first_byte() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data = vec![MERCHANT_TAG, 0, 0, 0];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &program_id);
        assert!(assert_tag(&acc, MERCHANT_TAG).is_ok());
    }

    #[test]
    fn assert_tag_rejects_mismatched_byte() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data = vec![INVOICE_TAG, 0, 0, 0];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &program_id);

        let err = assert_tag(&acc, MERCHANT_TAG).unwrap_err();
        assert_eq!(err, ZpError::NotMerchantAccount.into());
    }

    #[test]
    fn assert_tag_rejects_empty_account_data() {
        let key = Pubkey::new_from_array([1u8; 32]);
        let program_id = fixed_program_id();
        let mut lamports = 0u64;
        let mut data: Vec<u8> = vec![];
        let acc = make_account_info(&key, false, &mut lamports, &mut data, &program_id);

        let err = assert_tag(&acc, MERCHANT_TAG).unwrap_err();
        assert_eq!(err, ZpError::InvalidInstruction.into());
    }
}
