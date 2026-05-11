# Severity classification

The Immunefi listing uses the
[Immunefi Vulnerability Severity Classification System V2.3](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/)
as the parent framework, adapted for a Solana payment protocol that
holds **zero custody** of user funds.

Every report is categorised into one of four severities. The
ZettaPay security lead, with optional consultation from the audit
firm (Sec3, Soteria, or — at mainnet — OtterSec / Halborn), makes
the final call. Immunefi's mediation process applies if the
researcher disputes the severity assignment.

## Severity = `max(impact)` over plausible attack chains

A finding's severity is the **maximum impact** that any plausible
attack chain can achieve, regardless of the specific PoC submitted.
A high-impact bug demonstrated only with a small PoC is still high
severity — we do not pro-rate by demonstrated damage.

Because devnet has no real funds, severity is judged by the **mainnet
equivalent** of the same bug, not by realised devnet damage. A bug
that would steal $50k on mainnet is Critical even if the devnet
demonstration moves $0 of test USDC.

## Critical

### Definition

A bug that, if deployed to mainnet against the same program, would
cause one or more of:

- **Direct theft of user funds** via an on-chain bypass.
- **Permanent freeze** of any merchant's payouts via on-chain state
  the merchant cannot escape.
- **Arbitrary mutation** of an existing `MerchantBinding` or
  `Payment` PDA after creation, breaking the immutability invariant
  the protocol is built on.
- **Forgery of a receipt PDA** that the off-chain resolver
  unconditionally trusts, in a way that an attacker can exploit at
  scale without owning the corresponding `MerchantBinding`.

### Examples (illustrative, not exhaustive)

- An undocumented "facilitator override" path that lets a non-owner
  re-bind a `MerchantBinding` to a different `usdc_token_account`.
- A discriminator-collision path that lets an attacker pass an
  arbitrary account to `record_payment` and have it be accepted as a
  valid `MerchantBinding`.
- An integer arithmetic path that lets `amount` overflow inside the
  program even though `u64` is supposedly safe.
- A re-entrancy vector via a CPI that ZettaPay's `lib.rs` does not
  realise it is making.

### What does **not** count as Critical

- A bug that requires a victim merchant to sign an obviously bogus
  transaction. That is phishing / wallet UX, not a protocol bug.
- A bug that requires an attacker to already control the SPL Token
  program. The SPL Token program is upstream.
- Theft of test SOL or test USDC on devnet (no economic value).

### Mapped threats (from `../THREAT_MODEL.md`)

`T-IMMUT-01`, `T-IMMUT-02`, `T-SIGN-01`, `T-CPI-01`, `T-DISC-01`.

## High

### Definition

A bug that, on mainnet, would cause one or more of:

- **Theft of unclaimed rent** held by `MerchantBinding` or `Payment`
  PDAs (single accounts; aggregating to material value).
- **Spoofing of a merchant binding** in a way that confuses the
  off-chain resolver enough to misroute a non-trivial percentage of
  flows (but not all).
- **Forgery of a receipt PDA** tied to a `MerchantBinding` the
  attacker does not own, when the attack is materially harder than
  Critical (requires extra preconditions, requires the victim to take
  a specific off-chain action, etc.).
- **Denial of registration** for a specific high-value merchant via
  an on-chain mechanism the merchant cannot circumvent.

### Examples

- A bug where an attacker can `close` a `MerchantBinding` even though
  no `close_*` instruction is intentionally exposed.
- An off-by-one in `MerchantBinding::SIZE` that causes the account to
  become not-rent-exempt under specific mainnet rent rates.
- A signer-constraint bypass that requires the attacker to also win
  a Solana lottery-style race condition.

### What does **not** count as High

- Anything the off-chain stack mitigates fully on its own. If the
  bug is fully gated by an off-chain check, the off-chain code is
  the locus of the bug, and it is out of Immunefi scope.

## Medium

### Definition

- **Information disclosure** beyond what the public PDA already
  reveals — for instance, leaking a relationship that is meant to be
  private at the protocol level.
- **Griefing** that materially raises a merchant's operational cost
  on mainnet without violating the immutability invariant. Examples:
  rent inflation via attacker-initiated PDA creation in the
  merchant's namespace, transaction-size inflation that pushes
  `record_payment` over a cluster limit, etc.

### Examples

- A way for an attacker to pre-allocate `(merchant_binding,
  payment_id)` PDAs the merchant has not asked for, forcing the
  merchant's indexer to handle unexpected accounts.
- A serialisation quirk that leaks a private field in an event
  payload.

## Low

### Definition

Issues with negligible economic impact but that still violate a
documented invariant:

- A `MerchantBinding::SIZE` or `Payment::SIZE` constant that is
  technically larger than required.
- A handle-validation regex that accepts a Unicode codepoint that
  the documented charset rejects.
- An event field that is technically off-by-one from the persisted
  account state but is informational only (e.g. `recorded_at`).
- A missing `#[cfg(test)]` annotation on test-only code.

### What is below Low

We do not pay for:

- Style issues, naming, comment quality.
- Suggestions that the program adopt a different overall design
  (CPI to SPL Token to verify `usdc_token_account` on registration,
  for example — see [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md) K3).
- Reports that document accepted behaviour from
  [`../KNOWN_ISSUES.md`](../KNOWN_ISSUES.md).
- Reports that point at upstream dependencies (Anchor, SPL Token,
  Solana runtime, USDC mint, RPC providers, Vercel, Supabase).

## Severity disputes

If the researcher disagrees with the assigned severity:

1. They reply on the Immunefi report thread with the case for the
   higher severity, citing one of the definitions above.
2. The ZettaPay security lead responds within five business days
   with either an upgrade or a written explanation tying back to
   this file.
3. Unresolved disputes go to Immunefi's mediation per their
   standard terms.

## How severity maps to payout

See [`REWARDS.md`](REWARDS.md). The mapping is:

| Severity | Payout cap (devnet listing, Z28.2) | Payout cap (mainnet listing, Z22.1) |
| --- | --- | --- |
| Critical | up to $5,000 | up to $50,000 |
| High | up to $1,500 | up to $15,000 |
| Medium | up to $500 | up to $3,000 |
| Low | up to $100 | up to $1,000 |

The cap is the maximum; actual payout within the band reflects:

- Quality of the report (clarity, completeness of PoC).
- Whether a fix is proposed alongside the report.
- Whether the bug is novel or a near-duplicate of a previously
  surfaced concern.
