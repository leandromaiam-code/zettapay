# Immunefi listing — submission status log

> Single source of truth for where the **ZettaPay devnet validation
> bounty** sits in its Immunefi publication pipeline. Companion to
> [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md), which is the
> runbook; this file records *what has actually been done*.
>
> Mirrors the pattern used by
> [`community/listings/STATUS.md`](../../community/listings/STATUS.md)
> so an operator has one place to look across every outbound
> submission — ecosystem listings and the Immunefi listing alike.

## Stages

| Stage | Meaning |
| ----- | ------- |
| `package-ready` | Files in `audit/immunefi/` are complete and self-consistent. No action against `immunefi.com` yet. |
| `onboarding` | Immunefi project account created, domain TXT verified, owner wallet connected. No listing published. |
| `submitted` | Listing drafted on `immunefi.com/dashboard` and submitted for Immunefi review. |
| `live` | Listing publicly visible at the recorded URL — researchers can submit. |
| `paused` | Listing remains on Immunefi but is not accepting new submissions (e.g. Critical in active remediation, or mainnet listing supersedes per `SUBMISSION_CHECKLIST.md` "Pausing the listing"). |
| `superseded` | Devnet listing closed because the mainnet listing took over at Z22.1. |

## Current state (2026-05-16)

| Field | Value |
| ----- | ----- |
| Stage | `package-ready` |
| Last update | 2026-05-16 |
| Public URL | — (not yet listed) |
| Devnet program ID | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` |
| Commit pin (target) | `main` HEAD at publication time — recorded on transition to `submitted` |
| Pool size | up to **$10,000** |
| Owner contact | `security@zettapay.io` |

### Checklist progress

Mirrors [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md). Tick rows
here when the operator completes the matching step in the runbook —
do not duplicate the runbook contents, just track state.

| Step | Status | Last update | Notes |
| ---- | ------ | ----------- | ----- |
| Pre-flight: confirm devnet bytecode = `main` HEAD | open | 2026-05-16 | Z28.1 devnet beta runner (#174) deployed against devnet; bytecode re-pin needed at submission. |
| Pre-flight: record commit pin | open | 2026-05-16 | Capture `git rev-parse main` on the day of submission. |
| Onboarding: create Immunefi project account | open | 2026-05-16 | One-time; required before any listing draft. |
| Onboarding: DNS TXT for `zettapay.io` | open | 2026-05-16 | Domain proof step. |
| Onboarding: connect program owner wallet (multisig) | open | 2026-05-16 | Must match `packages/api/src/db/treasury_reserves.ts` treasury address. |
| Onboarding: set single intake to `security@zettapay.io` | open | 2026-05-16 | — |
| Listing: paste `PROGRAM.md` / `SCOPE.md` / `SEVERITY.md` / `REWARDS.md` / `RULES.md` per checklist field map | open | 2026-05-16 | Field map in `SUBMISSION_CHECKLIST.md` "Listing fields — devnet program". |
| Submit: hit Publish | open | 2026-05-16 | Transitions stage to `submitted`. |
| Post-publication: update change logs (`PROGRAM.md`, `REWARDS.md`, `ASSETS.json`) | open | 2026-05-16 | Append-only edits, one PR per `SUBMISSION_CHECKLIST.md` "Post-publication". |
| Post-publication: Discord `#security` + Twitter announcement | open | 2026-05-16 | Use existing community templates if present; factual tone only. |
| Post-publication: file end-of-Z28 calendar reminder | open | 2026-05-16 | Decide continue / pause / re-tier before mainnet listing at Z22.1. |

## How to update

1. Edit the row in place — change `Status`, `Last update`, and
   `Notes`. Allowed status values per row: `open`, `done`, `skipped`,
   `blocked` (with reason in `Notes`).
2. When the **Stage** in "Current state" transitions, append a dated
   line under `## History` below explaining what triggered the
   transition. Never silently move stages — every transition gets a
   history entry.
3. When `Stage = live`, also append the public URL to the change-log
   row in [`PROGRAM.md`](PROGRAM.md) and to
   [`ASSETS.json`](ASSETS.json) `program.effectiveFrom`, per the
   `SUBMISSION_CHECKLIST.md` "Post-publication" steps.
4. Never delete rows. If a checklist step is genuinely skipped, mark
   it `skipped` with a reason in `Notes` so a future operator does
   not re-litigate.

## Relationship to the mainnet listing

The mainnet `$50,000` listing has a separate status track in
[`../BUG_BOUNTY.md`](../BUG_BOUNTY.md) — that file's change-log
section is the equivalent record for the mainnet listing. When the
mainnet listing transitions to `live` at Z22.1, this devnet listing
moves to `superseded` (with a banner per `SUBMISSION_CHECKLIST.md`
"Pausing the listing") rather than being deleted.

## History

_(append-only; newest entry on top)_

- 2026-05-16 — Status log initialized. Stage `package-ready`. Listing
  package (`PROGRAM.md`, `SCOPE.md`, `SEVERITY.md`, `REWARDS.md`,
  `RULES.md`, `ASSETS.json`, `SUBMISSION_CHECKLIST.md`) shipped in
  PR #120 on 2026-05-11. No action against `immunefi.com` yet —
  awaiting devnet bytecode re-pin and operator onboarding.
