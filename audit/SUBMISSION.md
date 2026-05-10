# Audit submission and engagement logistics

This document describes how to engage on the audit and how the
deliverables will be shipped. It is the cover letter we attach to the
inbound to OtterSec or Halborn.

## Inbound message template

> **Subject:** ZettaPay (Solana / Anchor) — audit engagement, ~260 LOC, two instructions
>
> Hello,
>
> ZettaPay is a Solana USDC payment protocol launching on mainnet at
> the end of sprint Z22. Per our [security policy](https://github.com/leandromaiam-code/zettapay/blob/main/CLAUDE.md),
> we cannot ship to mainnet without a third-party audit of our on-chain
> program from OtterSec or Halborn.
>
> The on-chain surface is intentionally narrow:
> - 1 program crate, ~260 LOC of Rust including tests.
> - 2 instructions: `register_merchant`, `record_payment`.
> - 0 CPIs beyond the implicit system program rent transfer.
> - 0 custody — USDC moves directly between SPL token accounts.
> - 0 retained upgrade authority post-deploy (mandated by our launch checklist).
>
> The full audit submission package is at
> https://github.com/leandromaiam-code/zettapay/tree/main/audit
> and includes scope, threat model, security assumptions, known issues
> we've already self-disclosed, and the parallel bug bounty program.
>
> We're looking for:
> 1. A fixed-fee or fixed-day-count quote.
> 2. Earliest start date that fits a 1- to 2-week engagement window.
> 3. Confirmation that the toolchain pin (anchor 0.30.1, solana 1.18.26)
>    is acceptable for your reproducible build setup.
>
> Happy to jump on a call.
>
> — ZettaPay security

## Engagement preconditions

The auditor will receive, via the engagement letter:

1. **Pinned commit SHA** on the public `main` branch.
2. **Reproducible build instructions** (`anchor build` with the pinned
   toolchain — see [`SCOPE.md`](SCOPE.md#toolchain-must-match-for-reproducible-builds)).
3. **Devnet program ID and IDL** (see `scripts/deploy-devnet.sh`) so
   the auditor can interact with a live instance during the engagement
   without needing a local validator.
4. **Mutual NDA**, if requested. We default to permissionless
   disclosure, but will sign a standard mutual NDA if the audit firm
   prefers it.
5. **Direct line to engineering** — a Slack Connect channel with the
   ZettaPay engineering lead, available business hours UTC-3.

## Deliverables expected from the auditor

| Deliverable | Form |
| --- | --- |
| Draft report | PDF, with findings ranked by severity (Critical / High / Medium / Low / Informational), each with reproduction steps and a recommended remediation. |
| Live findings tracker | A shared Linear board or Google Sheet that we update as fixes land. |
| Final report | PDF, after remediation. Includes the original findings, the fix commits, and a re-test verdict per finding. |
| Sign-off attestation | Short signed statement that we are cleared for mainnet at a specific commit SHA. |
| Public summary | One-page public-facing PDF, MIT-licensed, suitable for hosting at `zettapay.io/security/audits/<firm>-<date>.pdf`. |

We expect to host the final report and the public summary at
`zettapay.io/security/audits/`. The auditor is welcome to mirror at
their own site.

## Re-audit decision tree

Per [`SCOPE.md`](SCOPE.md#re-audit-triggers):

```
Source change in programs/zettapay/src/lib.rs ?
├── No  ──>  no re-engagement
└── Yes ──>  Account layout or instruction surface changed?
              ├── No  ──>  Targeted re-review (~1 day)
              └── Yes ──>  Full re-engagement at original scope
```

## Multisig and deployment authority

During the audit window and through mainnet `--final` deploy, the
program upgrade authority is held by a 3-of-5 multisig. Members at
audit kickoff:

- Engineering lead
- CTO
- Independent advisor 1
- Independent advisor 2
- Cold-storage backup keypair (Trezor, offline)

Specific pubkeys are shared with the audit firm out-of-band and
stamped into the engagement letter. They are not committed to this
public repo.

## Security contact

- **Email:** `security@zettapay.io`
- **PGP fingerprint:** _(generated and published on Z22.1 cutover; will replace this line)_
- **Response SLA:** 48 hours business days, 5 days otherwise.

For the duration of an active audit engagement, the audit firm has a
direct line to the engineering lead and CTO outside of these channels.

## Timeline (target)

| Phase | Owner | Duration |
| --- | --- | --- |
| Inbound to audit firm + scope confirmation | ZettaPay → firm | 3 business days |
| Engagement letter signed | both | 5 business days |
| Audit window | firm | 1–2 weeks |
| Remediation | ZettaPay | 1 week |
| Re-test + final report | firm | 3 business days |
| Public summary published | both | 1 business day |
| Mainnet `--final` deploy | ZettaPay | 1 business day |

Total: ~4 weeks from initial inbound to mainnet sign-off.

## Cost envelope

We have budgeted **up to $50k** for the audit itself, separate from
the $50k public bug bounty pool. Quotes outside this envelope are
considered case-by-case; at the lower end of the firm's typical
Solana program engagement, this codebase should comfortably fit.

## Approval

This package is approved for outbound by the ZettaPay engineering
lead. Submission is gated on:

- [x] Threat model documented.
- [x] Scope file pinned.
- [x] Known issues disclosed up-front.
- [x] Bug bounty terms drafted.
- [ ] Engagement letter signed (post-quote).
- [ ] Multisig kickoff completed.
