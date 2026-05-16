# ZettaPay public bug bounty — $50,000

Per ZettaPay constitution rule 19, a $50,000 public bug bounty runs
**in parallel with** the formal audit, not after. The intent is to
broaden the reviewer pool while the audit is in flight, surface bugs
the audit firm may de-prioritize, and continue to incentivize external
review post-mainnet.

This program is intended to be hosted on **Immunefi** at
`immunefi.com/bug-bounty/zettapay/` once Z22.1 cuts the mainnet
deploy. The terms below are the canonical version; the Immunefi
listing is a mirror.

A **separate, smaller Immunefi listing** runs during Sprint Z28
(devnet validation, four weeks, $10k pool) — its submission package
lives in [`immunefi/`](immunefi/). The two listings share scope
boundaries and rules; the mainnet listing differs only in pool size,
program ID, and effective date.

### Devnet listing — package & status

The devnet submission package is canonical in `audit/immunefi/`:

- [`immunefi/PROGRAM.md`](immunefi/PROGRAM.md) — program overview submitted to Immunefi.
- [`immunefi/SCOPE.md`](immunefi/SCOPE.md), [`immunefi/SEVERITY.md`](immunefi/SEVERITY.md), [`immunefi/REWARDS.md`](immunefi/REWARDS.md), [`immunefi/RULES.md`](immunefi/RULES.md) — listing terms.
- [`immunefi/ASSETS.json`](immunefi/ASSETS.json) — machine-readable asset list for the Immunefi form.
- [`immunefi/SUBMISSION_CHECKLIST.md`](immunefi/SUBMISSION_CHECKLIST.md) — operator runbook for publishing the listing.
- [`immunefi/STATUS.md`](immunefi/STATUS.md) — append-only status log; the single source of truth for whether the listing is `package-ready`, `onboarding`, `submitted`, `live`, `paused`, or `superseded`.

For the current devnet stage and public URL, read `STATUS.md` first.

## Scope

| In scope | Out of scope |
| --- | --- |
| `programs/zettapay/src/lib.rs` on the mainnet program ID. | Any code in `packages/api/`, `packages/sdk/`, `packages/sdk-*`, `src/` (dashboard), or `plugins/`. |
| Account layout (`MerchantBinding`, `Payment`) at the deployed program. | Operational issues with our Vercel / Supabase / RPC providers. |
| The deployed BPF artefact matching the audited source. | Wallet adapter bugs (Phantom, x402 signers). |
| Bypasses of the immutability contract — i.e. any path that mutates a `MerchantBinding` or `Payment` after creation. | Issues in the SPL Token program, Solana runtime, Anchor framework, or the USDC mint. |
| Bypasses of the signer constraints on `register_merchant`. | Phishing, social engineering, or compromised user keys. |
| Deserialization bugs that allow account data corruption. | DoS by simply spending SOL to spam transactions. |

For off-chain code, we run a separate, lower-tier bounty
(`security@zettapay.io`) — those reports are triaged manually and do
not pay out of this $50k pool.

## Severity and payouts

We use the [Immunefi V2.3 vulnerability severity classification](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/),
adapted for a Solana program with no protocol custody.

| Severity | Definition | Payout |
| --- | --- | --- |
| **Critical** | Direct theft of user funds; permanent freeze of any merchant's payouts; arbitrary mutation of an existing `MerchantBinding` or `Payment` PDA. | up to **$50,000** |
| **High** | Theft of unclaimed rent; spoofing of a merchant binding; ability to forge a receipt PDA tied to a `MerchantBinding` you do not own. | up to **$15,000** |
| **Medium** | Information disclosure beyond what the public PDA already reveals; griefing that materially raises a merchant's operational cost. | up to **$3,000** |
| **Low** | Issues with negligible economic impact but that still violate a documented invariant. | up to **$1,000** |

Payouts are made in USDC on Solana to a wallet supplied by the
reporter, within 30 days of confirmed fix deployment. The full $50k is
the maximum total payout; we reserve the right to apportion across
multiple critical findings if more than one lands during the program.

## Rules of engagement

1. **Test only against devnet** until mainnet cutover, then against
   mainnet with a research wallet of your own funds.
2. **No DoS against shared infrastructure.** Do not flood our RPC
   providers, our API endpoints, or the public dashboard. Run your
   tests against your own RPC or against `solana-test-validator`.
3. **No social engineering**, no phishing, no compromise of employee
   accounts. Out of scope and out of bounds.
4. **Disclose privately to `security@zettapay.io`** with a PGP-encrypted
   report (key in [`SUBMISSION.md`](SUBMISSION.md)) before any public
   posting. Coordinated disclosure: 90 days from confirmed report, or
   the day a fix ships, whichever is sooner.
5. **One report per finding.** Multiple researchers reporting the same
   issue: first valid report wins; subsequent reporters are credited
   but not paid for the duplicate.

## What we count as "valid"

A report is valid when it:

- Names a specific instruction or PDA path.
- Describes the threat (what an attacker gains, who the victim is, how
  much loss is plausible).
- Provides a reproducer — either a failing Anchor test, a transaction
  signature on devnet, or a clear step-by-step that we can run on
  `solana-test-validator`.

Reports that read "we noticed `record_payment` does not verify
`tx_signature` against the cluster" are *not* findings — that is
documented behaviour. See [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md).

## Hall of fame

To be populated post-mainnet at `zettapay.io/security/researchers`.
Researchers may opt to be credited by handle / github / x, or to
remain anonymous.

## Coordination with the audit firm

OtterSec or Halborn (whichever firm is engaged) will be made aware of
the public bounty. Findings reported during the audit window are
triaged jointly: the audit firm validates technical accuracy, the
ZettaPay security lead handles the bounty payout decision. The audit
firm does *not* receive a cut of bounty payouts.

## Effective date

This program is effective from the day Z22.1 deploys to mainnet and
runs continuously thereafter. Changes to scope or payouts will be
versioned in this file with a change-log section appended below.

## Change log

| Date | Change |
| --- | --- |
| _(unset — set on Z22.1 cutover)_ | Initial $50k pool, scope as described above. |
