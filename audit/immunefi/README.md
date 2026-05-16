# ZettaPay × Immunefi bug bounty program package

This directory is the canonical submission package for posting the
ZettaPay public bug bounty on **Immunefi**. Listing a program on
Immunefi has zero hosting cost — payouts are only triggered by a
confirmed valid finding, in line with constitution rules 19 and 22.

There are **two distinct bounty programs**, tracked separately:

| Program | When it runs | Cluster | Pool size | File of record |
| --- | --- | --- | --- | --- |
| **Devnet validation bounty** (Z28.2) | Sprint Z28 — four weeks of devnet validation, audit-free | Solana **devnet** | up to **$10,000** total | this directory |
| **Mainnet $50k bounty** (Z22.1 onward) | From mainnet cutover, indefinitely | Solana **mainnet-beta** | up to **$50,000** total | [`../BUG_BOUNTY.md`](../BUG_BOUNTY.md) |

The devnet bounty exists to surface bugs **before** mainnet so the
audit-free path (Sec3 + Soteria + Immunefi) lands sprint Z28 with no
critical findings. The mainnet bounty runs in parallel with the
external audit (OtterSec or Halborn) and continues post-launch.

## Package contents

| File | Purpose |
| --- | --- |
| [`PROGRAM.md`](PROGRAM.md) | The full "About this program" content, Immunefi-formatted. Paste into the Immunefi listing description field. |
| [`SCOPE.md`](SCOPE.md) | In / out of scope at the level of asset, instruction, and account type. |
| [`ASSETS.json`](ASSETS.json) | Machine-readable list of in-scope assets in the shape Immunefi's API consumes (program ID, repo links, commit pin). |
| [`SEVERITY.md`](SEVERITY.md) | Severity definitions — Critical / High / Medium / Low — mapped to ZettaPay's threat model. |
| [`REWARDS.md`](REWARDS.md) | Payout table per tier, payout mechanics, multi-finding apportioning rules. |
| [`RULES.md`](RULES.md) | Rules of engagement, PoC requirements, prohibited actions, coordinated disclosure. |
| [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md) | Step-by-step for the ZettaPay security lead to actually post the listing on `immunefi.com`. |
| [`STATUS.md`](STATUS.md) | Submission status log — current stage, per-step progress, transition history. Mirrors `community/listings/STATUS.md`. |

## Why post on Immunefi

1. **Largest auditor / whitehat network in crypto** — broadens the
   reviewer pool beyond what we can reach directly.
2. **Triage tooling baked in** — duplicate detection, PoC requirements,
   severity rubric (we use Immunefi's V2.3 system as the parent).
3. **Reputation signal** — having a listed program tells merchants and
   AI-agent builders we treat the on-chain surface seriously.
4. **Zero listing cost** — Immunefi does not charge to host; ZettaPay
   only pays when a valid report lands.

## Relationship to the rest of the audit package

- The on-chain code under review is the same source the external
  auditor reviews (see [`../SCOPE.md`](../SCOPE.md)).
- The off-chain code path (API, SDK, dashboard, plugins) is **out of
  scope for the Immunefi listing** — those reports go to
  `security@zettapay.io` and are triaged manually under the existing
  lower-tier internal process.
- The Immunefi devnet listing references the devnet program ID
  declared in [`../../Anchor.toml`](../../Anchor.toml) and built by
  [`../../scripts/deploy-devnet.sh`](../../scripts/deploy-devnet.sh).
- The Immunefi mainnet listing (filed at Z22.1) references the
  finalised mainnet program ID and is governed by
  [`../BUG_BOUNTY.md`](../BUG_BOUNTY.md).

## What changes between devnet and mainnet listings

| Field | Devnet (Z28.2) | Mainnet (Z22.1) |
| --- | --- | --- |
| Program ID | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` (Anchor.toml `[programs.devnet]`) | Set at Z22.1 cutover; recorded in `../BUG_BOUNTY.md` change log |
| Cluster | `devnet` | `mainnet-beta` |
| Pool size | up to **$10,000** | up to **$50,000** |
| Critical payout cap | $5,000 | $50,000 |
| Effective from | Listing date in Sprint Z28 | Mainnet deploy timestamp (Z22.1) |
| Settlement currency | USDC on Solana devnet (test, non-redeemable); payouts settled on mainnet USDC to reporter wallet | USDC on Solana mainnet |
| Commit pin | `main` HEAD at listing date | `main` HEAD at Z22.1 deploy |
| Audit firm coordination | None — audit-free phase | OtterSec or Halborn engaged in parallel |

Every other rule — scope boundaries, PoC requirements, disclosure
window — is identical between the two listings. The mainnet listing is
the devnet listing with the pool size and program ID swapped.

## Maintenance

- The ZettaPay security lead (currently `security@zettapay.io`) is the
  named program owner on Immunefi.
- Any change to scope, severity, or rewards is versioned in the change
  log of the relevant file (devnet listing here, mainnet listing in
  `../BUG_BOUNTY.md`).
- Re-listing on a new commit happens on every audit re-engagement and
  whenever `programs/zettapay/src/lib.rs` changes — same trigger as the
  audit re-engagement (see [`../SCOPE.md`](../SCOPE.md#re-audit-triggers)).
