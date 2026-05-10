# Security assumptions

The program in `programs/zettapay/src/lib.rs` is correct *given* the
following assumptions. Each one is a load-bearing trust statement; if
the auditor has reason to doubt any, please flag it.

## Cryptographic and runtime

1. **Solana runtime correctness.** The Solana runtime correctly
   verifies Ed25519 signatures, enforces account discriminators when
   Anchor's `Account<'info, T>` macro is used, and rejects writes to
   accounts the instruction did not declare as writable.
2. **Anchor `init` semantics.** Anchor's `#[account(init, payer, ...)]`
   constraint correctly:
   - Allocates the requested space.
   - Funds rent from `payer`.
   - Zero-initializes the account.
   - Rejects re-creation against a PDA that already holds an account
     (returning `Already in use` / `0x0` from the system program).
3. **PDA derivation determinism.** `Pubkey::create_program_address`
   produces the same PDA for the same `(seeds, program_id)` and
   nothing else does, modulo the `bump` byte the program records.
4. **`Clock::get()` honesty.** The cluster-provided `unix_timestamp` is
   approximately monotonic per slot. The program uses it only for
   informational fields (`registered_at`, `recorded_at`) and never for
   authorization, so small clock skew is acceptable.

## Toolchain

5. **anchor-cli 0.30.1 + solana 1.18.26.** The build is reproducible at
   the pinned versions. Mismatched versions can produce different BPF
   bytecode for the same source, so the audit report must include the
   exact toolchain hashes used (see [`SUBMISSION.md`](SUBMISSION.md)).
6. **Release-profile flags.** `Cargo.toml` sets
   `overflow-checks = true` for the release profile, so any arithmetic
   overflow panics rather than silently wrapping. (The program does no
   user-driven arithmetic, but this is belt-and-braces.)

## Off-chain layer

7. **The off-chain registration flow validates `usdc_token_account`
   before submitting the on-chain registration.** The program
   intentionally does not re-verify; the SPL Token program rejects
   transfers to non-token accounts at settlement time, so a bad ATA
   simply means no payment ever lands. The SDK and dashboard refuse to
   register a binding whose ATA does not pass:
   - `getAccountInfo` returns a token account.
   - The mint matches the canonical Solana USDC mint.
   - The owner matches the registering wallet.

8. **Verifiers resolve `tx_signature` against the cluster.** Receipt
   PDAs are claims, not proofs. The SDK calls
   `connection.getTransaction(tx_signature)` and checks that the
   transaction:
   - Was confirmed.
   - Contains a `transferChecked` instruction over the SPL Token
     program.
   - Routes USDC to the binding's `usdc_token_account`.
   - Settles `amount` (modulo SPL decimals).
   The program itself cannot perform these checks from inside an
   instruction.

## Operational

9. **Upgrade authority is removed before mainnet.** The Z22.1 launch
   checklist includes `solana program deploy --final` and a manual
   verification step that `program_account.upgrade_authority_address`
   is `null`. The auditor is asked to spot-check the on-chain state of
   the deployed program at sign-off.

10. **Deployer keypair is held in a 3-of-5 multisig from audit through
    `--final`.** No single keyholder can deploy or upgrade. Members
    are listed in [`SUBMISSION.md`](SUBMISSION.md).

11. **No private branch deviates from `main`.** The audit is pinned to
    a public commit on `main`. Any fix-during-audit will land on
    `main` and re-pin the engagement to a new commit; we never run a
    side branch the auditor cannot see.

## Out-of-scope assumptions (called out so they are not silently
implicit)

- Wallet adapters (Phantom for humans, x402 signers for AI agents)
  honestly produce the user's signature. If an adapter is malicious,
  every Solana program is compromised; this is not a ZettaPay-specific
  risk.
- The USDC mint authority is honest. USDC freezes are a Circle
  prerogative; if Circle freezes the merchant's ATA, USDC stops
  flowing — this is a property of using USDC, not a property of
  ZettaPay.
- The audit firm itself is honest. We accept this risk by choosing
  OtterSec or Halborn.
