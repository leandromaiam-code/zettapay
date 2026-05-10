# Threat model — ZettaPay on-chain program

This document enumerates the threats we have considered against the
program in `programs/zettapay/src/lib.rs`, the mitigations the code
relies on, and where each mitigation is enforced. It is structured so an
auditor can read the threat, jump to the source, and either confirm the
mitigation is sound or flag the gap.

The model uses **STRIDE** (Spoofing, Tampering, Repudiation, Information
disclosure, Denial of service, Elevation of privilege) and one
**economic** category (Funds), since this is a payments protocol.

---

## Trust boundaries

```
   ┌────────────────┐       ┌────────────────────┐       ┌──────────────────┐
   │  Merchant      │       │  Payer / AI agent  │       │  Facilitator     │
   │  (owns wallet) │       │  (signs SPL xfer)  │       │  (rent payer)    │
   └───────┬────────┘       └─────────┬──────────┘       └────────┬─────────┘
           │ register_merchant           │ SPL transferChecked        │ record_payment
           │ (signs as `owner`)          │ (signs as token authority) │ (signs as `payer`)
           ▼                             ▼                             ▼
                ┌──────────────────────────────────────────┐
                │  ZettaPay program (no upgrade authority) │
                │   ┌─────────────────────┐                │
                │   │ MerchantBinding PDA │  immutable     │
                │   └─────────────────────┘                │
                │   ┌─────────────────────┐                │
                │   │ Payment PDA          │ immutable     │
                │   └─────────────────────┘                │
                └──────────────────────────────────────────┘
                                ▲
                                │ assumed correct (upstream audits)
                ┌───────────────┴─────────────────────┐
                │ SPL Token program • Solana runtime  │
                └─────────────────────────────────────┘
```

The program never sees, holds, or moves USDC. USDC moves entirely inside
the SPL Token program, between the payer's token account and the
merchant's `usdc_token_account` referenced in their binding. ZettaPay's
program only writes immutable receipts.

---

## S — Spoofing

### S1. Third party binds a handle to a wallet they don't control

**Attack.** Mallory submits `register_merchant("acme-store", mallory_ata)`
naming Bob's wallet as `owner` so future payers resolving `acme-store`
route USDC to her ATA.

**Mitigation.**
- `RegisterMerchant.owner: Signer<'info>` (`lib.rs:115`) — `owner` must
  sign the transaction. Mallory cannot produce Bob's signature without
  Bob's key.
- `payer` is a separate `Signer` (`lib.rs:120`) so the rent payer cannot
  doubled as a forged owner.
- The PDA seeds include `owner.key()` (`lib.rs:108`); Mallory's own
  wallet would derive a different PDA from her own owner-keyed seed,
  and that PDA is what `init` would attempt — she cannot collide with
  Bob's binding.

**Residual risk.** A compromised merchant key. Out of scope for the
program; addressed by the launch checklist guidance to use hardware
wallets and the [post-binding rotation guide](../docs/concepts/architecture.mdx).

### S2. Forged `merchant_binding` in `record_payment`

**Attack.** Mallory passes an arbitrary account (or her own
`MerchantBinding` PDA) as `merchant_binding` to `record_payment` to
attach a receipt to the wrong merchant.

**Mitigation.**
- `Account<'info, MerchantBinding>` (`lib.rs:131`) enforces Anchor's
  account discriminator check; arbitrary accounts that are not
  `MerchantBinding` PDAs of *this program* are rejected with
  `AccountDiscriminatorMismatch`.
- The PDA seed `merchant_binding.key()` (`lib.rs:140`) ties the receipt
  PDA to *that* binding key. Mallory recording against her own binding
  produces a receipt under her PDA, not Bob's — payers verify by
  reading Bob's binding's receipts, not the cluster at large.

**Residual risk.** A payer trusting a receipt PDA without checking the
parent binding. Mitigated off-chain by the SDK, which always resolves
the binding first; the program cannot enforce client behaviour.

---

## T — Tampering

### T1. Rewriting an existing binding

**Attack.** A merchant whose business model changes wants to repoint
`acme-store` → a new ATA without churning their handle off-chain.

**Mitigation.**
- No `update_merchant_binding` instruction exists. The `#[program] mod`
  has only two functions (`lib.rs:25-85`).
- Anchor's `init` constraint rejects re-creation at the same
  `(handle, owner)` PDA.

**Design note.** This is the immutability contract, not a bug. A
merchant who needs to repoint must register a new handle, then publish
the deprecation off-chain. We considered allowing rotation behind an
owner-signed `update`; we explicitly rejected it because the
`(handle → wallet)` binding is what payers cache, and silent repointing
would let a compromised key reroute future payments.

### T2. Rewriting a payment receipt

**Attack.** A merchant or attacker changes the `amount` or
`tx_signature` on an existing receipt to misrepresent settled state.

**Mitigation.**
- No `update_payment` instruction exists.
- Anchor's `init` constraint rejects re-creation at the same
  `(merchant_binding, payment_id)` PDA.

### T3. Account data overwrite via incorrect deserialization

**Attack.** Anchor's account macros mis-handle a String field of
malicious length to overflow the allocated rent space.

**Mitigation.**
- `merchant_handle` length is checked *before* assignment (`lib.rs:33-40`).
- `MerchantBinding::SIZE` (`lib.rs:166-171`) reserves
  `4 + MERCHANT_HANDLE_MAX_LEN` for the borsh-encoded string,
  matching the 32-byte upper bound enforced at runtime.
- Unit test `binding_size_within_pda_max` (`lib.rs:243`) sanity-checks
  the reserved size against the 10 KiB PDA ceiling.

**Asks of the auditor.** Confirm the `4 + MAX_LEN` borsh accounting is
correct (we want eyes on this — it's the most error-prone size constant
in the file).

---

## R — Repudiation

### R1. Merchant denies receiving a payment

**Attack.** A merchant claims they never received payment, hoping to
charge back or extract a duplicate.

**Mitigation.**
- The `Payment` PDA exists on-chain, signed into existence by *some*
  facilitator and discoverable by `seeds = [merchant_binding, payment_id]`.
- The receipt anchors `tx_signature: [u8; 64]` of the underlying SPL
  transfer (`lib.rs:62`); the SPL Token program's own logs confirm
  settlement to the merchant's ATA.
- `PaymentRecorded` event (`lib.rs:75-81`) is emitted on success and
  indexable by RPC consumers and SDK clients.

### R2. Merchant denies registration ownership

**Attack.** A merchant later disputes that they signed the binding.

**Mitigation.**
- `owner: Signer<'info>` is required at registration (`lib.rs:115`).
- `MerchantRegistered` event (`lib.rs:49-54`) is emitted on success.
- The transaction itself, on-chain forever, contains the owner's
  signature.

---

## I — Information disclosure

### I1. PII inside `merchant_handle`

**Attack.** A merchant registers a handle that contains personal data,
which is then immutably and publicly readable.

**Mitigation.**
- The handle is constrained to `[a-z0-9_-]{3,32}` (`lib.rs:87-96`),
  which limits but does not prevent encoding PII.
- The off-chain dashboard validates against a wider denylist
  (profanity, look-alikes, reserved words) and warns merchants that
  handles are public + permanent.

**Residual risk.** A merchant who insists on encoding PII in the
handle. Acceptable per product design — the handle is intended to be a
public business identifier, like a Stripe account name.

### I2. Account size leaks unused bytes

**Attack.** Borsh-serialized `String` may zero-fill remainder; an
auditor might worry about side-channel leakage of prior account state.

**Mitigation.**
- Anchor's `init` zero-initializes the account before the program
  writes; previously-deallocated bytes are not exposed.

---

## D — Denial of service

### D1. Griefing via PDA front-run

**Attack.** Mallory watches the mempool, sees Bob's `register_merchant`
broadcast, and tries to register the same handle first.

**Mitigation.**
- The PDA seeds include `owner.key()` (`lib.rs:108`), so Mallory's
  attempt resolves to *Mallory's* PDA, not Bob's. They cannot collide.
- Two merchants choosing the same human-readable handle is allowed at
  the protocol level — they differ by `owner`. The off-chain layer
  prevents UX confusion by reserving the global `(handle)` namespace
  for the first registrant; on-chain, the program is namespace-neutral.

### D2. Rent exhaustion via mass receipt spam

**Attack.** An attacker calls `record_payment` against a victim's
binding many times with random `payment_id`s, forcing the merchant or
facilitator to track useless PDAs.

**Mitigation.**
- Each `record_payment` requires the *attacker* to fund the rent (the
  attacker is `payer`); the merchant pays nothing. (`lib.rs:150-151`).
- The receipt cannot impersonate a real payment because `tx_signature`
  is a 64-byte field that any verifier compares against the actual SPL
  transfer signature returned by RPC. A bogus receipt with a fake
  `tx_signature` resolves to a transaction that does not exist, or to
  a transaction that did not transfer USDC to the merchant's ATA, and
  is discarded by the SDK.

**Residual risk.** Indexer cost: a third-party indexing the program may
ingest spam receipts. Mitigated off-chain by the SDK validating each
receipt against the SPL Token transfer it claims to anchor before
treating it as authoritative.

### D3. Compute budget exhaustion

**Attack.** An adversarial input causes the instruction to exceed the
Solana compute budget and revert in a way that locks subsequent
instructions.

**Mitigation.**
- Both instructions are O(1) and operate on bounded inputs
  (`merchant_handle` ≤ 32 bytes, `payment_id` exactly 32 bytes,
  `tx_signature` exactly 64 bytes).
- No loops over user-supplied collections.

---

## E — Elevation of privilege

### E1. Permissionless `record_payment` mis-classified as a privilege

**Design choice, not a vulnerability.** Anyone — merchant, payer, AI
agent, indexer — can record a receipt. This is intentional: receipts
are *proofs* of settled state, not authorisations of new state. The
authorisation is the SPL Token transfer itself, signed by the payer.
Allowing third-party anchoring removes a coordination chokepoint and
enables AI agents to anchor their own receipts.

We flag this here so an auditor reviewing for "missing signer checks"
does not log a finding against the `payer`-only `record_payment`
constraints.

### E2. Program upgrade authority retained post-deploy

**Attack.** A retained upgrade authority can replace `lib.rs` with a
malicious version that drains future payments or rewrites past
receipts.

**Mitigation.**
- The launch checklist (Z22.1) mandates `solana program deploy --final`
  on mainnet, removing the upgrade authority.
- During the audit window the upgrade authority is held by a
  3-of-5 multisig (members listed in [`SUBMISSION.md`](SUBMISSION.md))
  so a single compromise does not enable an upgrade.

**Asks of the auditor.** Verify the on-chain `program_account.upgrade_authority_address`
is `null` (or a known multisig pubkey at audit time) on the deployed
mainnet program before signing the report off.

---

## Funds — Economic / payment-flow threats

### F1. USDC routed to the wrong ATA

**Attack.** A binding's `usdc_token_account` field is wrong (typo, mint
mismatch, frozen ATA) so settled USDC ends up somewhere unrecoverable.

**Mitigation.**
- The on-chain program does not validate that
  `usdc_token_account` is a real USDC ATA owned by `owner`. This is by
  design — the program does not pull USDC, the *payer*'s SPL transfer
  does, and the SPL Token program will reject a non-token-account
  destination at transfer time.
- The off-chain registration flow validates the ATA with an RPC
  `getAccountInfo` and rejects mismatched mints before submitting the
  registration tx.

**Asks of the auditor.** Confirm whether the auditor recommends adding
an on-chain owner-of-ATA check (cheaper to fail at registration than
at first-payment). Open question we want a recommendation on.

### F2. Receipt anchoring a transfer that never happened

**Attack.** A facilitator anchors a `record_payment` with a fabricated
`tx_signature` that does not correspond to any real settlement.

**Mitigation.**
- The on-chain program does *not* verify that `tx_signature` is a
  real, confirmed SPL transfer to the binding's ATA. It can't — a
  signature is opaque from inside an instruction without a syscall to
  load another transaction.
- Verifiers (the merchant's webhook handler, the SDK) MUST treat the
  receipt as a *claim* and resolve `tx_signature` against the cluster
  before trusting it. The SDK does this.

This is the single largest "the on-chain program does less than you'd
think" deviation from a naive Stripe-like model. It is the right
deviation: anchoring exists to publish a verifiable claim, not to
re-prove the underlying SPL transfer that the cluster has already
proven.

### F3. Replay across chains

**Attack.** ZettaPay later expands to a second chain (premise 1
explicitly defers this to Z11). Could a receipt's `tx_signature` from
chain A be replayed on chain B?

**Mitigation.**
- Out of scope until Z11. Currently single-chain.
- Z11 design will namespace receipts by chain id so a future
  cross-chain SDK does not silently accept a chain-A signature against
  a chain-B binding.

---

## Summary table

| ID | Category | Severity if unmitigated | Mitigation | Confidence |
| --- | --- | --- | --- | --- |
| S1 | Spoofing | Critical | `Signer<'info>` + PDA seed | High |
| S2 | Spoofing | High | Anchor discriminator check | High |
| T1 | Tampering | Critical | No update instruction | High |
| T2 | Tampering | High | No update instruction | High |
| T3 | Tampering | High | Length check + size constant | **Medium — please verify** |
| R1 | Repudiation | Medium | On-chain receipt + event | High |
| R2 | Repudiation | Medium | On-chain registration + event | High |
| I1 | Info disclosure | Low | Charset constraint + UX warning | Medium |
| I2 | Info disclosure | Low | Anchor zero-init | High |
| D1 | DoS | Medium | Owner-keyed PDA | High |
| D2 | DoS | Low | Attacker funds rent + off-chain validation | Medium |
| D3 | DoS | Low | O(1) bounded instructions | High |
| E1 | EoP | N/A — design choice | Documented above | High |
| E2 | EoP | Critical | Launch-checklist `--final` deploy + multisig | **Operational, please verify** |
| F1 | Funds | Medium | Off-chain ATA validation + SPL rejection | **Open question** |
| F2 | Funds | Medium | Off-chain signature verification | High |
| F3 | Funds | Out of V1 scope | Deferred to Z11 | High |
