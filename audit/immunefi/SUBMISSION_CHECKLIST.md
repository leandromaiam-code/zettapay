# Posting the listing on Immunefi — step-by-step

This is the operator's checklist for the ZettaPay security lead to
actually publish the program on `immunefi.com`. Listing is **free**;
ZettaPay only pays when a confirmed valid finding lands. The checklist
walks the security lead through every field Immunefi asks for, with
the canonical source-of-truth file linked next to each field.

## Pre-flight

- [ ] Read [`README.md`](README.md) to confirm devnet vs mainnet listing
      separation and what changes between them.
- [ ] Confirm the on-chain program at
      `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` on devnet is the
      bytecode built from current `main` HEAD. Run:
      ```
      bash scripts/deploy-devnet.sh
      ```
      If the deploy is idempotent (same program ID), the listed commit
      pin will match the deployed bytecode.
- [ ] Record the **commit pin** for the listing — the `main` HEAD at
      the time you publish. Capture it with:
      ```
      git rev-parse main
      ```
      Save this value; you will paste it into the Immunefi listing
      metadata and into the change log at the bottom of
      [`PROGRAM.md`](PROGRAM.md) and [`ASSETS.json`](ASSETS.json).
- [ ] Confirm `security@zettapay.io` is the published contact email and
      that you can receive Immunefi platform notifications on it.

## Immunefi platform onboarding (one-time)

If the ZettaPay project has not yet been onboarded:

- [ ] Create the project account at `https://immunefi.com/dashboard`.
- [ ] Verify domain ownership of `zettapay.io` via the DNS TXT method
      Immunefi provides.
- [ ] Connect the program owner wallet (Solana mainnet USDC). Use a
      multisig wallet, not a hot keypair. The wallet should match the
      treasury reserve address declared in
      `packages/api/src/db/treasury_reserves.ts` for auditability.
- [ ] Set the **single intake email** to `security@zettapay.io`. All
      out-of-Immunefi reports continue to land there too.
- [ ] Read Immunefi's listing standard and confirm ZettaPay's program
      meets the criteria for the "Smart Contract" track on Solana.

## Listing fields — devnet program

| Immunefi field | Value | Source |
| --- | --- | --- |
| Program name | `ZettaPay (devnet validation)` | [`README.md`](README.md) |
| Slug | `zettapay-devnet` | [`ASSETS.json`](ASSETS.json) `program.slug` |
| Project description | Paste contents of [`PROGRAM.md`](PROGRAM.md) | this directory |
| Logo | `audit/immunefi/logo.png` — TODO: confirm before listing | will be added at publication time |
| Project type | `Protocol → Payments / Stablecoin` | Immunefi taxonomy |
| Project status | `Live on Solana devnet` | program ID is deployed |
| Chain | `Solana` | [`Anchor.toml`](../../Anchor.toml) |
| Cluster | `devnet` | [`ASSETS.json`](ASSETS.json) `program.cluster` |
| Smart contract addresses | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` (devnet) | [`ASSETS.json`](ASSETS.json) `inScope[0].programId` |
| Source repo | `https://github.com/leandromaiam-code/zettapay` | [`ASSETS.json`](ASSETS.json) `inScope[0].source.repo` |
| Source commit | `<git rev-parse main at listing time>` | recorded at publication |
| Audit reports | Sec3 + Soteria automated scans, run during Sprint Z28 (audit-free). External firm audit (OtterSec / Halborn) is filed against the mainnet listing at Z22.1, not this one. | [`../README.md`](../README.md) |
| Documentation | `https://docs.zettapay.io` | docs site |
| Threat model | `https://github.com/leandromaiam-code/zettapay/blob/main/audit/THREAT_MODEL.md` | [`../THREAT_MODEL.md`](../THREAT_MODEL.md) |
| Known issues | `https://github.com/leandromaiam-code/zettapay/blob/main/audit/KNOWN_ISSUES.md` | [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) |
| In-scope assets | Per [`SCOPE.md`](SCOPE.md) "In-scope assets" + [`ASSETS.json`](ASSETS.json) `inScope` | this directory |
| Out-of-scope assets | Per [`SCOPE.md`](SCOPE.md) "Out-of-scope assets" + [`ASSETS.json`](ASSETS.json) `outOfScope` | this directory |
| Impacts in scope | Per [`ASSETS.json`](ASSETS.json) `inScope[0].impactsInScope` | this directory |
| Severity classification | Paste contents of [`SEVERITY.md`](SEVERITY.md) | this directory |
| Reward table | Paste the tier table from [`REWARDS.md`](REWARDS.md) (devnet column) | this directory |
| Total pool | `up to $10,000` | [`REWARDS.md`](REWARDS.md) |
| Reward currency | `USDC` on Solana mainnet | [`REWARDS.md`](REWARDS.md) |
| KYC required | `No` (but sanctioned-jurisdiction settlement may be withheld) | [`REWARDS.md`](REWARDS.md), [`RULES.md`](RULES.md) clause 28 |
| Rules of engagement | Paste contents of [`RULES.md`](RULES.md) | this directory |
| Disclosure window | `90 days from acceptance, or fix-ship day, whichever is sooner` | [`RULES.md`](RULES.md) clauses 10–11 |
| Acknowledgment SLA | `2 business days` | [`RULES.md`](RULES.md) clause 24 |
| Triage SLA | `10 business days` | [`RULES.md`](RULES.md) clause 25 |
| Fix ETA SLA | `20 business days` | [`RULES.md`](RULES.md) clause 26 |
| Payout SLA | `30 calendar days from fix ship` | [`REWARDS.md`](REWARDS.md) |
| Program owner contact | `security@zettapay.io` | [`README.md`](README.md) |
| Public PGP key | as published in [`../SUBMISSION.md`](../SUBMISSION.md) | shared with audit firm too |
| Effective from | listing approval date | recorded in change logs |

## Submit

- [ ] Hit "Publish" on the Immunefi dashboard for the `zettapay-devnet`
      listing.
- [ ] Verify the listing renders cleanly at
      `https://immunefi.com/bug-bounty/zettapay-devnet/` (or the slug
      Immunefi assigns).
- [ ] Cross-check every field above against the canonical file. If any
      field drifted, fix the file (not the listing) and re-sync the
      listing from the file.

## Post-publication

- [ ] Update the change-log row in [`PROGRAM.md`](PROGRAM.md) with the
      effective date and commit pin.
- [ ] Update the change-log row in [`REWARDS.md`](REWARDS.md) with the
      same date.
- [ ] Update [`ASSETS.json`](ASSETS.json) — set
      `program.effectiveFrom` and `inScope[0].source.commitPin`.
- [ ] Open a PR for the change-log updates (one PR, one commit, no
      other changes) so the publication is auditable.
- [ ] Announce on the ZettaPay Discord `#security` channel and on
      Twitter `@zettapay`. Use the templates in
      `community/discord/security-announcement.md` and
      `community/twitter/security-announcement.md` if they exist;
      otherwise keep it factual: program name, scope summary, pool
      size, listing URL. No marketing language.
- [ ] File a calendar reminder for the **end of Sprint Z28** to assess
      whether the program should run continuously, be paused while
      preparing the mainnet listing, or be re-tiered.

## When to re-list

Re-list (publish a new commit pin or a new program ID) when **any of**:

- A line of `programs/zettapay/src/lib.rs` changes.
- `MerchantBinding` or `Payment` account layout changes.
- A new instruction is added to the program.
- Anchor or Solana toolchain bumps to a different minor.

Comment-only edits, `#[cfg(test)] mod tests` changes, and patch-level
dependency bumps do **not** require a re-listing.

## Pausing the listing

Pause (not delete) the listing if:

- A confirmed Critical finding is in active remediation. Pause until
  the fix ships and is re-deployed.
- The mainnet listing supersedes the devnet listing — pause the
  devnet listing on Z22.1 mainnet deploy day, do not delete (so the
  hall of fame and change log remain visible).

When pausing, post a banner on the listing pointing researchers to
the active listing.
