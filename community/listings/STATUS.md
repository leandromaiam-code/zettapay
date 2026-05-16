# Listing submissions — status log

> Single source of truth for where each of the 5 ecosystem listings sits
> in its submission pipeline. Companion to the per-target drafts in this
> directory.
>
> Forward-referenced from `rpc-providers.md` line 35 ("Track responses
> in `community/listings/STATUS.md`"). Now realised for all 5 targets,
> not just RPC providers, so the operator has one place to look.

## Stages

| Stage | Meaning |
| ----- | ------- |
| `drafted` | Payload exists in `community/listings/<target>.md`. Not yet sent. |
| `submitted` | Payload sent to the target (PR opened / form submitted / email sent). |
| `acknowledged` | Counterparty replied or visibly received (PR has reviewer, email opened, form auto-reply). |
| `live` | Listing publicly visible at the recorded URL. |
| `rejected` | Target declined. Reason in `History`. |
| `stale` | No response after 60 days. Decide on re-outreach. |

## Current state (2026-05-16)

| # | Target | Stage | Last update | Public URL | Notes |
| - | ------ | ----- | ----------- | ---------- | ----- |
| 1 | Anza grants | drafted | 2026-05-11 | — | Awaiting brand kit + audit summary attach before form submit. |
| 2 | Solana Pay registry | drafted | 2026-05-11 | — | PR against `anza-xyz/solana-pay`; payload in `solana-pay-registry.md`. |
| 3 | awesome-solana | drafted | 2026-05-11 | — | PR against `avareum/awesome-solana`; one-line entry in `awesome-solana.md`. |
| 4 | RPC providers (×5) | drafted | 2026-05-11 | — | Cold emails to Helius, Triton, QuickNode, Alchemy, Chainstack. See sub-table. |
| 5 | solana.com + Superteam | drafted | 2026-05-11 | — | solana.com/ecosystem self-serve + Superteam Earn. |

### RPC providers — per-provider

| Provider | Stage | Last update | Public URL | Notes |
| -------- | ----- | ----------- | ---------- | ----- |
| Helius | drafted | 2026-05-11 | — | — |
| Triton One | drafted | 2026-05-11 | — | — |
| QuickNode | drafted | 2026-05-11 | — | — |
| Alchemy | drafted | 2026-05-11 | — | — |
| Chainstack | drafted | 2026-05-11 | — | — |

## How to update

1. Edit the row in place — change `Stage`, `Last update`, and `Public URL`.
2. If a transition needs context (rejection reason, contact name,
   follow-up date), append a dated line under `## History` below.
3. Never delete rows. Mark abandoned targets `rejected` with a reason
   so a future operator does not re-litigate the decision.
4. When `Stage = live`, also append the public URL under the matching
   draft file's `Status` line, per the README convention.

## History

_(append-only; newest entry on top)_

- 2026-05-16 — Status log initialized. All 5 targets at `drafted`; none
  submitted yet. Submission gated on brand kit (`logo/wordmark-*.png`,
  `logo/symbol-*.png`) and audit summary (`audit/`) attach at send time.
