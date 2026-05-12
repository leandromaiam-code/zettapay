# ZettaPay smart contract audit package

This directory is the canonical submission package for an external audit
of the ZettaPay on-chain program. It targets two firms with deep Solana /
Anchor experience:

- **OtterSec** — `audit@osec.io`
- **Halborn** — `solana-audits@halborn.com`

Either firm can be engaged; the package is identical. Refer the auditing
team to this directory and the linked source paths — every artefact they
need to bid, schedule, and execute the audit lives here or in the program
source tree.

## Why we are auditing

ZettaPay's [constitution](../CLAUDE.md) makes external audit a hard gate
before mainnet:

> **16. Mainnet só após F8 (build gate Fabric) + Z21 (audit) + Z22 (launch checklist).**
>
> **18. Smart contracts auditados (OtterSec ou Halborn) antes mainnet — Z21.**
>
> **19. Bug bounty $50k público pre-mainnet.**

The program is intentionally tiny — two instructions, no upgrade
authority post-deploy, no privileged signer beyond the merchant owner
themselves. Scope is narrow on purpose so the engagement can be priced
and finished inside a single sprint.

## Package contents

| File | Purpose |
| --- | --- |
| [`SCOPE.md`](SCOPE.md) | Exact files, commit, LOC, in / out of scope. |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | STRIDE-style threat catalogue + mitigations claimed. |
| [`SECURITY_ASSUMPTIONS.md`](SECURITY_ASSUMPTIONS.md) | Trust boundaries, invariants the program relies on. |
| [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md) | Self-disclosed concerns and accepted limitations. |
| [`BUG_BOUNTY.md`](BUG_BOUNTY.md) | Public $50k bounty terms running in parallel with the audit (mainnet listing, Z22.1). |
| [`immunefi/`](immunefi/) | Immunefi submission package for the Sprint Z28 devnet validation bounty ($10k pool) and forward-reference for the Z22.1 mainnet listing. |
| [`SUBMISSION.md`](SUBMISSION.md) | Engagement logistics, NDAs, deliverables, timeline. |
| [`STATIC_ANALYSIS.md`](STATIC_ANALYSIS.md) | Sec3 X-ray + Soteria static-analysis sweep (Z28.3): 14 check classes mapped 1:1 to source, plus the offline `scripts/static-analysis-rust.sh` that re-runs them on every PR. |
| [`CODE_REVIEW_CHECKLIST.md`](CODE_REVIEW_CHECKLIST.md) | Off-chain pre-audit code-review gate (Z21.5). |
| [`CRITICAL_PATHS.md`](CRITICAL_PATHS.md) | Off-chain critical paths and the path-specific review rules. |
| [`OWASP_TOP_10.md`](OWASP_TOP_10.md) | OWASP 2021 Top 10 mapped to off-chain mitigations + tests. |

## Source the auditor will be looking at

| Path | What it is |
| --- | --- |
| [`programs/zettapay/src/lib.rs`](../programs/zettapay/src/lib.rs) | The entire on-chain program — two instructions, two account types, three error codes. |
| [`programs/zettapay/Cargo.toml`](../programs/zettapay/Cargo.toml) | Crate manifest. |
| [`Anchor.toml`](../Anchor.toml) | Anchor + Solana toolchain pins (`anchor 0.30.1`, `solana 1.18.26`). |
| [`Cargo.toml`](../Cargo.toml) | Workspace manifest with `overflow-checks = true` for release builds. |
| [`tests/zettapay.ts`](../tests/zettapay.ts) | Anchor integration tests against `solana-test-validator`. |
| [`idl/zettapay.json`](../idl/zettapay.json) | Generated IDL — useful for cross-checking instruction discriminators. |
| [`scripts/deploy-devnet.sh`](../scripts/deploy-devnet.sh) | Devnet deploy procedure that will be re-used for mainnet (with cluster swapped). |

## At a glance

- **Program**: 1 crate, ~260 lines of Rust including unit tests.
- **Instructions**: 2 (`register_merchant`, `record_payment`).
- **Account types**: 2 (`MerchantBinding`, `Payment`).
- **External CPIs**: none. The program calls no other on-chain program
  beyond the implicit `system_program` rent transfer that Anchor's
  `init` performs.
- **Custody**: zero. The program never touches USDC; it only writes
  immutable PDAs that *describe* off-chain settled transfers.
- **Mutability**: zero post-creation. There is no `update_*` or
  `close_*` instruction; PDAs are write-once.

The narrow surface area is deliberate. Anything that needs to change
state (balances, fees, settlement) happens in the SPL Token program
itself, which is already audited and battle-tested. ZettaPay's program
exists only to anchor the `(merchant_handle → wallet)` binding and
`(merchant, payment_id) → (amount, signature)` receipts on chain so they
cannot be silently rewritten by either side.

## Out of scope for this engagement

- The off-chain ZettaPay API (`packages/api/`) — not on-chain code.
- The TypeScript SDK (`packages/sdk/`) — not on-chain code.
- The merchant dashboard, plugins, marketplace — none are on-chain code.
- The SPL Token program, Solana runtime, Anchor framework, USDC mint
  itself — these are upstream and outside the engagement.
- Operational security of the deployer keypair — addressed separately
  via the launch checklist (Z22.1).

See [`SCOPE.md`](SCOPE.md) for the full in / out matrix.

## Off-chain coverage

The off-chain code (API, SDK, dashboard, plugins) is not part of the
external Anchor audit, but it moves real value and handles sensitive
data, so it has its own pre-audit gate:

- [`CODE_REVIEW_CHECKLIST.md`](CODE_REVIEW_CHECKLIST.md) — the row-by-row
  checklist a reviewer walks before any off-chain change merges.
- [`CRITICAL_PATHS.md`](CRITICAL_PATHS.md) — the eight paths that lose
  USDC, leak KYC, or break protocol safety if they regress, plus the
  path-specific review rules.
- [`OWASP_TOP_10.md`](OWASP_TOP_10.md) — every OWASP 2021 category
  mapped to the off-chain code that mitigates it and the test that
  proves it.

These three documents together are the off-chain surface answer to
"how do you know the rest of the codebase is audit-ready?".
