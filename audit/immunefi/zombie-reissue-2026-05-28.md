---
mission_uuid: 8c3ce720
mission_name: Z28.2
reissue_date: 2026-05-28
status: zombie
---

# Z28.2 — zombie re-issue (UUID 8c3ce720)

The autodev orchestrator fired Z28.2 ("Bug bounty Immunefi setup: posta
programa publico, define scope, define bounties tier") with a fresh UUID
`8c3ce720` on 2026-05-28. The full scope has **already shipped** on
`main` via two prior PRs:

| PR | Date | UUID | Contents |
| -- | ---- | ---- | -------- |
| [#120](https://github.com/leandromaiam-code/zettapay/pull/120) | 2026-05-11 | `cecb56dc` | Initial Immunefi devnet bug bounty submission package — `audit/immunefi/{PROGRAM,SCOPE,SEVERITY,REWARDS,RULES,ASSETS,SUBMISSION_CHECKLIST,README}.{md,json}` (8 files). |
| [#196](https://github.com/leandromaiam-code/zettapay/pull/196) | 2026-05-16 | `3eac77b8` | Submission status log — `audit/immunefi/STATUS.md`. |

Together those two PRs land all nine canonical files under
`audit/immunefi/` covering exactly the deliverable described in the
mission spec:

- **Public program copy** (`PROGRAM.md`)
- **Scope** (`SCOPE.md` + `ASSETS.json`)
- **Tiered bounty table** low/med/high/critical (`SEVERITY.md` + `REWARDS.md`)
- **Rules & disclosure terms** (`RULES.md`)
- **Operator runbook + status tracker** (`SUBMISSION_CHECKLIST.md` + `STATUS.md`)

No additional code or docs are required to satisfy Z28.2. This sentinel
PR exists only to:

1. Acknowledge the orchestrator re-fire for telemetry / audit trail.
2. Prevent the autodev squad from duplicating the package (which would
   cause spurious merge conflicts and burn review bandwidth).

## Note on staleness (out of scope for Z28.2)

The shipped package targets the Solana devnet program and Anchor
bytecode at `programs/zettapay/src/lib.rs`. The product has since
pivoted (Z47/Z50/Z53) to non-custodial BTC xpub + EVM USDC and the
Solana code is now quarantined under `packages/legacy-solana/` (Z49).

Refreshing the Immunefi scope to match the current architecture is a
**separate mission** (new sprint, not Z28). Do not bundle it here.

## Action

Sentinel-only. Close this PR after orchestrator acknowledgement; no
code changes accompany this commit aside from this note.
