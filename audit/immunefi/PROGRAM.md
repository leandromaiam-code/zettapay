# ZettaPay — Immunefi program description

> **This file is the canonical content of the "About this program"
> section on the Immunefi listing.** Paste verbatim into the listing
> description; keep both copies in sync via PR.

## Program summary

ZettaPay is a Solana-native payment protocol for AI agents and
merchants. It anchors merchant identity and payment receipts on chain
as **immutable PDAs**, while the actual USDC value transfer is handled
by the SPL Token program. The protocol does **not** custody funds; the
on-chain program writes write-once records that describe off-chain
settled transfers.

This bounty covers the on-chain Anchor program — two instructions, two
account types, three error codes, no upgrade authority post-deploy.
The off-chain stack (API, SDK, dashboard, plugins) is **out of scope**
for this listing and is triaged separately by the ZettaPay security
team.

## Project links

- Website: [`https://zettapay.io`](https://zettapay.io)
- Documentation: [`https://docs.zettapay.io`](https://docs.zettapay.io)
- Source: [`https://github.com/leandromaiam-code/zettapay`](https://github.com/leandromaiam-code/zettapay)
- Audit package: [`audit/`](https://github.com/leandromaiam-code/zettapay/tree/main/audit)
- Threat model: [`audit/THREAT_MODEL.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/THREAT_MODEL.md)
- Known issues (self-disclosed): [`audit/KNOWN_ISSUES.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/KNOWN_ISSUES.md)

## Cluster and program ID under review

- **Cluster:** Solana **devnet** (`https://api.devnet.solana.com`)
- **Program ID:** `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS`
- **Source commit pinned to:** `main` HEAD at listing date — recorded in
  the Immunefi listing metadata and in [`SUBMISSION_CHECKLIST.md`](SUBMISSION_CHECKLIST.md).
- **Anchor / Solana toolchain:** `anchor 0.30.1`, `solana 1.18.26` (see
  [`Anchor.toml`](https://github.com/leandromaiam-code/zettapay/blob/main/Anchor.toml)).

The mainnet listing (separate Immunefi program, filed at sprint Z22.1)
will reference the finalised mainnet program ID and pool size; see
[`audit/BUG_BOUNTY.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/BUG_BOUNTY.md).

## Scope at a glance

**In scope:**

- `programs/zettapay/src/lib.rs` deployed at the program ID above.
- Account layouts: `MerchantBinding`, `Payment`.
- Instructions: `register_merchant`, `record_payment`.
- The BPF artefact deployed to devnet must match the audited source.
- Bypasses of immutability — any path that mutates a `MerchantBinding`
  or `Payment` after creation.
- Bypasses of the signer constraints on `register_merchant`.
- Deserialization paths that corrupt account state.

**Out of scope:**

- `packages/api/`, `packages/sdk/`, `packages/sdk-go/`, `packages/sdk-php/`,
  `packages/sdk-python/`, `packages/sdk-rust/`, `packages/widget/`,
  `src/` (dashboard), `plugins/`.
- SPL Token program, Solana runtime, Anchor framework, USDC mint.
- Wallet adapters (Phantom, x402 signers).
- Operational issues with our RPC providers, Vercel, Supabase.
- Phishing, social engineering, key compromise of any party.
- DoS by spending SOL to spam transactions on the public cluster.

Full table: [`SCOPE.md`](SCOPE.md).

## Severity and payouts

We use the [Immunefi V2.3 severity classification](https://immunefi.com/immunefi-vulnerability-severity-classification-system-v2-3/),
adapted for a Solana program with no protocol custody.

| Severity | Definition (devnet-adapted) | Payout |
| --- | --- | --- |
| **Critical** | A class of bug that would directly steal user funds, permanently freeze any merchant's payouts, or arbitrarily mutate an existing `MerchantBinding` or `Payment` PDA on mainnet. Demonstrated on devnet against the listed program ID. | up to **$5,000** |
| **High** | Theft of unclaimed rent; spoofing of a merchant binding; ability to forge a receipt PDA tied to a `MerchantBinding` the attacker does not own. | up to **$1,500** |
| **Medium** | Information disclosure beyond what the public PDA already reveals; griefing that materially raises a merchant's operational cost on mainnet. | up to **$500** |
| **Low** | Issues with negligible economic impact but that still violate a documented invariant (e.g. an account-size constant that admits an off-by-one but does not cause data loss). | up to **$100** |

Total pool: **up to $10,000** for the devnet validation phase
(four weeks of Sprint Z28). The mainnet listing at Z22.1 carries a
$50k pool.

Detailed mapping of each severity to ZettaPay's threat model:
[`SEVERITY.md`](SEVERITY.md). Payout mechanics: [`REWARDS.md`](REWARDS.md).

## What we count as a valid finding

A report is valid when it:

1. Names a specific instruction or PDA path.
2. Describes the threat — what the attacker gains, who the victim is,
   what loss is plausible on mainnet were the same bug deployed.
3. Provides a reproducer — a failing Anchor test, a devnet transaction
   signature, or a step-by-step that runs against `solana-test-validator`.

Reports that describe behaviour already documented as accepted in
[`audit/KNOWN_ISSUES.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/KNOWN_ISSUES.md)
are not findings.

Full rules: [`RULES.md`](RULES.md).

## Coordinated disclosure

- Submit privately through Immunefi's submission flow. Do **not**
  contact `security@zettapay.io` for findings inside Immunefi scope —
  the Immunefi platform is the single intake.
- Standard Immunefi disclosure window applies: 90 days from confirmed
  report, or the day a fix ships, whichever is sooner.
- Public disclosure prior to fix forfeits the bounty.

## Program owner

- **ZettaPay security lead** — `security@zettapay.io`
- PGP key for direct contact (audit firm coordination only): published
  in [`audit/SUBMISSION.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/SUBMISSION.md).

## Effective date and change log

- Devnet listing effective: listing approval date in Sprint Z28
  (target: within 30 minutes of mission Z28.2 deploy, per
  constitution rule 30 effort budget).
- Mainnet listing effective: mainnet deploy timestamp at Z22.1.
- Any change to scope, severity, or rewards is versioned in the change
  log appended to this file (devnet) or to
  [`audit/BUG_BOUNTY.md`](https://github.com/leandromaiam-code/zettapay/blob/main/audit/BUG_BOUNTY.md)
  (mainnet).

## Change log

| Date | Change |
| --- | --- |
| _(unset — set on Immunefi listing approval)_ | Initial devnet listing, $10k pool, scope as described above. |
