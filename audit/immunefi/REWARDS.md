# Reward tiers and payout mechanics

## Tier table — devnet listing (Sprint Z28)

| Severity | Definition (summary) | Payout cap |
| --- | --- | --- |
| **Critical** | On-chain bypass that would steal funds, freeze payouts, or break the immutability invariant if deployed to mainnet. | up to **$5,000** |
| **High** | Rent theft, binding spoofing, receipt forgery (harder preconditions than Critical), or denial of registration. | up to **$1,500** |
| **Medium** | Information disclosure beyond what the public PDA reveals; griefing that raises merchant operational cost. | up to **$500** |
| **Low** | Documented-invariant violation with negligible economic impact. | up to **$100** |

**Total pool for the devnet listing: up to $10,000** for the duration
of Sprint Z28 (four weeks).

The corresponding mainnet listing (Z22.1) caps Critical at $50,000
and uses a $50,000 total pool — see [`../BUG_BOUNTY.md`](../BUG_BOUNTY.md).

## Why "up to"

Each cap is the maximum we will pay for a single finding of that
severity. The actual payout within the band reflects:

- **Report quality** — a one-paragraph PoC at Critical may pay less
  than a fully fleshed-out report at the same severity.
- **Proposed fix** — researchers who attach a Rust patch or a Anchor
  test reproducing the bug get the high end of the band.
- **Novelty** — a bug we have *already* flagged in
  [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) is not in scope; a bug
  near-adjacent to a known issue is judged on whether the new vector
  was foreseeable from the disclosure.

## Settlement currency

Payouts are made in **USDC on Solana mainnet** to a wallet supplied
by the reporter, even when the bug is demonstrated on devnet. The
devnet listing does not pay in test USDC — those tokens have no
exchange value.

We do not pay in fiat. If a researcher requires a different
settlement rail, they should flag it on the Immunefi thread before
acceptance; we'll consider USDC on a single alternative chain
(Ethereum, Base, Arbitrum) on a case-by-case basis.

## Settlement timeline

Within **30 days of confirmed fix deployment**. The clock starts
the day:

1. The fix is merged to `main`.
2. The fix is deployed to devnet (or, for the mainnet listing,
   mainnet).
3. The researcher and the ZettaPay security lead jointly confirm the
   fix addresses the report.

If a researcher's report is accepted but the fix takes longer than
60 days to ship, we pay 50% of the awarded amount on day 60 and the
remainder on the fix-ship day. This is to avoid researchers being
held hostage by our own roadmap.

## Multi-finding apportioning

The $10,000 pool is the maximum total payout across **all** valid
findings in the program. If two Critical reports land in the same
window, both are paid up to the Critical cap **so long as the pool
holds**; if the pool would be exceeded, both reports are pro-rated
proportionally to their assessed quality scores, with a guaranteed
minimum of $1,000 each.

We commit to topping up the pool within 14 days of any payout that
draws it below 20% of the cap. This is to keep the program "always
live" — a researcher arriving mid-sprint should not find the pool
empty.

## Duplicate handling

**One report per finding.** When multiple researchers report the
same issue:

- The **first valid report** (by Immunefi timestamp) wins the full
  payout.
- Subsequent reports are credited in the hall of fame but receive no
  monetary award.
- If the second report demonstrates a strictly worse case of the
  same root cause (e.g. higher impact, easier reproduction), we
  re-assess; the second reporter gets the difference between what
  the first earned and what the worst-case finding would have
  earned, at our discretion.

## Out of scope for payout (even if the report is technically valid)

- Findings against code outside the [`SCOPE.md`](SCOPE.md) in-scope
  list — the off-chain stack has its own (non-monetary) intake at
  `security@zettapay.io`.
- Findings against upstream dependencies (SPL Token, Anchor, Solana
  runtime, USDC mint, wallet adapters, RPC providers).
- Findings against operational infrastructure (Vercel, Supabase,
  GitHub Actions, npm registry).
- Findings that depend on social engineering, phishing, or
  compromised user keys.
- Findings that depend on the researcher running a malicious RPC
  node — protocol assumes a benign RPC; this is documented.
- Findings that depend on tampering with the source repository — the
  audit assumes the deployed bytecode matches the audited source,
  and the listing pins a commit.
- Findings already documented in [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md)
  as accepted behaviour.

## Tax and reporting

We do not provide tax advice. Researchers are responsible for the
tax treatment of any payout in their jurisdiction.

If a researcher's home jurisdiction prohibits accepting bounty
payments from the ZettaPay entity, we will note the report in the
hall of fame and forfeit payment with the researcher's consent.

## Change log

| Date | Change |
| --- | --- |
| _(unset — set on Immunefi listing approval)_ | Initial $10k pool for devnet listing, four severity tiers as defined. |
