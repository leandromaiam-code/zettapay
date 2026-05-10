# Audit scope

## Commit

The audit is pinned to the `main` branch HEAD at the moment the
engagement is signed. The exact commit SHA will be stamped into the
engagement letter and re-stamped on every re-review after fix
remediation.

## Toolchain (must match for reproducible builds)

| Component | Version | Source of truth |
| --- | --- | --- |
| anchor-cli | `0.30.1` | `Anchor.toml` |
| solana-cli | `1.18.26` | `Anchor.toml` |
| rustc / cargo | stable that produces a working `anchor 0.30.1` BPF build | not pinned beyond Anchor's own requirement |

Release profile in `Cargo.toml` enables `overflow-checks = true`,
`lto = "fat"`, and `codegen-units = 1`. Auditors should reproduce with
these on; debug-mode behaviour differs.

## In scope

### Files

| File | LOC (incl. tests) | Notes |
| --- | --- | --- |
| `programs/zettapay/src/lib.rs` | ~263 | The whole on-chain program. Two instructions, two accounts, three error codes, five `#[cfg(test)]` unit tests. |
| `programs/zettapay/Cargo.toml` | ~15 | Crate manifest. |
| `Cargo.toml` (workspace) | ~14 | Release-profile flags affect generated BPF. |
| `Anchor.toml` | ~26 | Toolchain + program-id pins. |

Total auditable surface: **one Rust file under ~265 lines**, plus the
manifests.

### Behaviours

1. **Instruction `register_merchant(merchant_handle, usdc_token_account)`**
   - PDA derivation correctness: `seeds = [merchant_handle.as_bytes(), owner.key()]`.
   - Handle validation: `3..=32` bytes, `^[a-z0-9][a-z0-9_-]*$`.
   - Signer constraints on `owner` and `payer`.
   - Re-registration rejection via Anchor `init`.
   - Account size (`MerchantBinding::SIZE`) sufficient for max-length
     handle (rent-exemption + no overflow).

2. **Instruction `record_payment(payment_id, amount, tx_signature)`**
   - PDA derivation correctness: `seeds = [merchant_binding.key(), payment_id]`.
   - Amount validation: `> 0`.
   - Discriminator check on `merchant_binding` so an unrelated account
     cannot stand in.
   - Permissionless `payer` semantics — anyone may anchor a receipt.
   - Re-record rejection via Anchor `init`.
   - Account size (`Payment::SIZE`) matches the field layout.

3. **Account immutability**
   - No `update_*` instruction.
   - No `close_*` instruction.
   - No upgrade authority retained on the program after the
     `solana program deploy --final` step described in the launch
     checklist (Z22.1).

4. **Event emission correctness**
   - `MerchantRegistered` and `PaymentRecorded` payloads match the
     persisted account state.

### Properties to verify

- **PDA uniqueness.** `(handle, owner)` and `(merchant_binding, payment_id)`
  are 1:1 with their PDAs.
- **No silent re-write.** Any second call against an existing PDA
  returns `Already in use` (Anchor `0x0` system error or
  `ConstraintInit`), not success.
- **No privileged signer bypass.** Neither instruction accepts a
  "facilitator can override owner" path.
- **No integer overflow.** `amount: u64` and `recorded_at: i64` are
  bounded by SPL Token's own checks; the program does no arithmetic on
  them. Confirm no implicit arithmetic was missed.
- **No reentrancy or CPI surface.** The program performs no CPI other
  than the implicit `system_program` rent transfer Anchor's `init`
  emits. Confirm.
- **Rent-exemption.** `MerchantBinding::SIZE` and `Payment::SIZE` are
  large enough that Anchor's `init` allocates a rent-exempt account on
  mainnet's current rent rates. (The unit tests assert each is under
  10 KiB; rent-exemption is the live property.)

## Out of scope

| Item | Why out |
| --- | --- |
| `packages/api/`, `packages/sdk/`, `packages/sdk-*` | Off-chain code. Audited separately via codebase review + bug bounty, not by an Anchor auditor. |
| Merchant dashboard (`src/`), plugins, marketplace | Off-chain UI. |
| SPL Token program, USDC mint, Solana runtime, Anchor framework | Upstream dependencies. Not in our control; assumed correct per their own audits. |
| Operational security of the deployer keypair | Procedural; covered by Z22.1 launch checklist (HSM, multisig upgrade authority handoff, key ceremony). |
| Wallet adapter security (Phantom, x402 signers) | Client-side; outside on-chain trust boundary. |
| RPC provider trust (Helius, Triton, etc.) | Operational; payers verify confirmations themselves. |
| Off-chain idempotency keys, rate-limit windows, webhook signing | Off-chain code paths. |

## Re-audit triggers

A re-engagement of equal scope is required if any of the following
change between sign-off and mainnet:

- Any line of `programs/zettapay/src/lib.rs` is modified.
- Account layout (`MerchantBinding` or `Payment`) changes.
- Instruction surface gains a new entry, even if non-mutating.
- Anchor or solana toolchain version is bumped to a different minor.

A targeted re-review (cheaper, scoped) is acceptable for:

- Comment-only edits.
- Unit-test-only edits in `#[cfg(test)] mod tests`.
- Dependency bumps in `programs/zettapay/Cargo.toml` that do not change
  Anchor's major or minor.

The decision tree lives in [`SUBMISSION.md`](SUBMISSION.md).
