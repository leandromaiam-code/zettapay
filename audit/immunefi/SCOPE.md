# Immunefi listing — scope

Mirrors [`../SCOPE.md`](../SCOPE.md), restated in the format the
Immunefi triage team and submitting researchers expect. If the two
disagree, [`../SCOPE.md`](../SCOPE.md) is canonical and this file is
updated to match.

## In-scope assets

### Smart contract (on-chain)

| Asset type | Identifier | Cluster |
| --- | --- | --- |
| Solana program | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` | devnet |
| Source file | `programs/zettapay/src/lib.rs` (~263 LOC) | repo `main` HEAD at listing |
| Source file | `programs/zettapay/Cargo.toml` | repo `main` HEAD at listing |
| Source file | `Cargo.toml` (workspace, release profile flags) | repo `main` HEAD at listing |
| Source file | `Anchor.toml` (toolchain + program-id pin) | repo `main` HEAD at listing |

### Instructions in scope

1. **`register_merchant(merchant_handle, usdc_token_account)`**
   - PDA derivation: `seeds = [merchant_handle.as_bytes(), owner.key()]`.
   - Handle validation: `3..=32` bytes, regex `^[a-z0-9][a-z0-9_-]*$`.
   - Signer constraints on `owner` and `payer`.
   - Re-registration rejection via Anchor `init`.

2. **`record_payment(payment_id, amount, tx_signature)`**
   - PDA derivation: `seeds = [merchant_binding.key(), payment_id]`.
   - Amount validation: `> 0`.
   - Discriminator check on `merchant_binding`.
   - Re-record rejection via Anchor `init`.

### Account types in scope

- `MerchantBinding` — write-once PDA mapping `(handle, owner) →
  (usdc_token_account, registered_at)`.
- `Payment` — write-once PDA mapping `(merchant_binding, payment_id) →
  (amount, tx_signature, recorded_at)`.

### Properties under review

| Property | What we want a researcher to prove or disprove |
| --- | --- |
| PDA uniqueness | `(handle, owner)` and `(merchant_binding, payment_id)` are 1:1 with their PDAs. No bug allows two valid PDAs at the same seed pair. |
| Write-once invariant | No path mutates a `MerchantBinding` or `Payment` after creation. |
| Signer-only registration | `register_merchant` rejects unsigned `owner`. |
| Discriminator safety | `record_payment` rejects an account that has the right size but the wrong discriminator. |
| No silent re-write | Second `init` call against an existing PDA returns `Already in use`, never success. |
| No CPI surface | Program performs no CPI beyond the implicit `system_program` rent transfer Anchor's `init` emits. |
| Integer safety | `amount: u64` and `recorded_at: i64` arithmetic — confirm no implicit op was missed. |
| Event payload correctness | `MerchantRegistered` and `PaymentRecorded` payloads match the persisted account state. |

## Out-of-scope assets

| Item | Why out |
| --- | --- |
| `packages/api/` (Express server, Postgres adapters, route handlers) | Off-chain. Triaged at `security@zettapay.io`. |
| `packages/sdk/`, `packages/sdk-go/`, `packages/sdk-php/`, `packages/sdk-python/`, `packages/sdk-rust/` | Off-chain client libraries. |
| `packages/widget/` | Off-chain embed widget. |
| `src/` (merchant dashboard) | Off-chain UI. |
| `plugins/` | Off-chain commerce-platform integrations. |
| SPL Token program | Upstream Solana program. Not in our control. |
| USDC mint and its authorities | Out of our trust boundary. |
| Anchor framework, Solana runtime | Upstream dependencies; their own audit and bounty programs apply. |
| Wallet adapters (Phantom, x402 signers) | Client-side; outside on-chain trust boundary. |
| RPC providers (Helius, Triton, devnet public RPC) | Operational; payers verify confirmations themselves. |
| Deployer keypair operational security | Procedural; covered by [`../SUBMISSION.md`](../SUBMISSION.md) and the Z22.1 launch checklist. |
| Phishing, social engineering, key compromise | Out of the trust boundary. |
| DoS by spending SOL to spam transactions on the public cluster | Not a protocol-level bug. |
| Issues in code that compiles only under `#[cfg(test)]` | Not deployed to the cluster. |
| Anything reported as accepted in [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) | Documented behaviour, not a finding. |

## Impact-in-scope vs impact-out-of-scope

Borrowing Immunefi's "impacts in scope" language:

**Impacts in scope** (eligible for payout if a credible PoC is produced):

- Direct theft of user funds via an on-chain bypass — e.g. forcing a
  `record_payment` to fire against a binding the attacker controls
  when the SPL transfer landed in a victim's ATA.
- Permanent freeze of any merchant's payouts via on-chain state.
- Arbitrary mutation of `MerchantBinding` or `Payment` after init.
- Theft of unclaimed rent.
- Spoofing of a merchant binding (forging an alternate PDA that the
  off-chain resolver mis-resolves to).
- Forging a receipt PDA tied to a `MerchantBinding` the attacker does
  not own.

**Impacts out of scope** (will be closed as duplicate / not applicable
even with a working PoC):

- Theft of test SOL or test USDC on devnet — devnet assets have no
  market value. Severity is judged by what the same bug would cost on
  **mainnet**, not by realised devnet damage.
- Front-running of `record_payment` by paying higher priority fees —
  permissionless `payer` is documented behaviour ([`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md), K-related).
- `tx_signature` mismatch with the actual SPL transfer it claims to
  attest — documented as K1 in [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).
- Two different owners registering the same `merchant_handle` —
  documented as K2.
- Cluster timestamp drift in `registered_at` / `recorded_at` —
  documented as K6.
- Anything in the upstream dependencies above.

## Re-scoping triggers

The Immunefi listing is re-issued (new commit pin, possibly new program
ID) when any of:

- A line of `programs/zettapay/src/lib.rs` changes.
- `MerchantBinding` or `Payment` layout changes.
- A new instruction is added to the program.
- Anchor or solana toolchain bumps to a different minor version.

Comment-only edits, unit-test-only edits in `#[cfg(test)] mod tests`,
and patch-level dependency bumps do not require a re-listing.
