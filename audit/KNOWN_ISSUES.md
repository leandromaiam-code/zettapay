# Known issues and self-disclosed concerns

We are flagging these up-front so the audit report can either confirm
they are accepted, downgrade them, or upgrade them to actionable
findings. None are blockers for the audit itself.

## K1. `record_payment` cannot prove the underlying SPL transfer

**Where.** `programs/zettapay/src/lib.rs:59-84`.

**Description.** A receipt PDA stores `(amount, tx_signature)`, but
the program does not verify that `tx_signature` refers to a real
confirmed `transferChecked` of `amount` USDC into the binding's ATA.
Verification happens off-chain in the SDK / merchant webhook handler.

**Why we accept it.** Inside an instruction, a Solana program cannot
load a sibling transaction. An on-chain proof would require either:

- A cross-instruction sysvar inspection of an SPL transfer in the same
  transaction, which would force every receipt to be co-bundled with
  its transfer — fragile and incompatible with the AI-agent use case
  where the receipt is anchored after settlement by a different party.
- A separate ZK proof system, far above the complexity budget for V1.

**Mitigation we ship.** The SDK's `verifyReceipt(receipt)` helper
performs the off-chain verification and is the canonical primitive for
trusting a receipt. Documented in `docs/sdk/on-chain.mdx`.

**What we want from the audit.** Confirmation that the on-chain
`record_payment` correctly anchors the *claim* (no silent corruption,
no tampering vector), and that documenting the off-chain verification
contract is sufficient.

## K2. `merchant_handle` namespace is not globally unique on chain

**Where.** `programs/zettapay/src/lib.rs:108`.

**Description.** PDAs are seeded by `(handle, owner)`, so two different
owners could each register `acme-store`. Off-chain, the dashboard
reserves the global `(handle)` namespace first-come-first-served. On
chain, both PDAs are valid.

**Why we accept it.** Adding global uniqueness would require a global
registry account that becomes a hot account (contention) and a single
point of failure. Off-chain coordination is sufficient for the user
need (avoiding handle confusion on the public marketplace).

**What we want from the audit.** Confirmation that this design choice
does not enable a spoofing or rerouting attack. (We believe it does
not — payers always resolve via the `(handle, owner)` pair the
merchant publishes, not via handle alone — but want a second opinion.)

## K3. No on-chain validation of `usdc_token_account`

**Where.** `programs/zettapay/src/lib.rs:32` (parameter accepted
without on-chain checks).

**Description.** A merchant could register a binding whose
`usdc_token_account` is not actually a USDC token account they own.

**Why we accept it.** The SPL Token program rejects bad transfers at
settlement time, so a bad ATA means no payment ever lands — funds are
not lost, they simply do not arrive. The off-chain registration flow
validates the ATA before submitting the registration tx.

**Open question for the audit.** Is the audit team's recommendation to
add an on-chain check (e.g. CPI to SPL Token's `getAccount` to verify
mint and owner)? Cost: more compute units per registration, more code
in the audited surface. Benefit: registration fails fast on bad input
instead of producing a binding that silently never receives.

## K4. `tx_signature` is stored as `[u8; 64]`, not a typed signature

**Where.** `programs/zettapay/src/lib.rs:62`, `:178`.

**Description.** The signature is stored as raw bytes with no on-chain
verification step. This is intentional — the program does no
cryptographic validation of `tx_signature`, so there is no benefit to
using a typed `Signature` over a byte array.

**What we want from the audit.** A sanity check that storing
`[u8; 64]` is the right primitive (no surprising serialization
behaviour vs `solana_program::signature::Signature`).

## K5. `payment_id` is opaque to the program

**Where.** `programs/zettapay/src/lib.rs:61`, `:178`.

**Description.** `payment_id: [u8; 32]` is treated as an opaque
identifier. Off-chain, it is generated as either:

- 32 random bytes (default), or
- `sha256(merchant_id || external_invoice_id)` for merchants
  integrating with their own order systems.

**Why we accept it.** The program enforces uniqueness per
`(merchant_binding, payment_id)`; semantic interpretation belongs at
the application layer.

**What we want from the audit.** Confirmation that no on-chain check
should constrain `payment_id` (e.g. forbidding the all-zero value).
We currently allow any 32-byte value.

## K6. `registered_at` and `recorded_at` are cluster timestamps, not
authoritative wall clock

**Where.** `programs/zettapay/src/lib.rs:47`, `:73`.

**Description.** `Clock::get()?.unix_timestamp` is the cluster's
sysvar-reported timestamp, which can drift by seconds. We use these
fields informationally (display, sorting) and never for authorization.

**What we want from the audit.** Acknowledgement that informational
use is acceptable.

## K7. Five `#[cfg(test)]` unit tests; richer property-based tests live
in TypeScript

**Where.** `programs/zettapay/src/lib.rs:221-262` and
`packages/api/test/merchantBinding.test.ts`,
`packages/api/test/paymentRecord.test.ts`,
`tests/zettapay.ts`.

**Description.** The Rust unit tests cover handle validation and
size-constant pinning. Behavioural tests (PDA derivation,
re-registration rejection, signer requirements) live in
`tests/zettapay.ts` against `solana-test-validator`, and
TypeScript-side seed contract tests live in the API package.

**Why we accept it.** The Anchor integration test gives us full
behavioural coverage; doubling it up in Rust would not strengthen the
guarantee. CI does not run `anchor test` because the Vercel
environment has no Rust toolchain — see
[`SCOPE.md`](SCOPE.md#out-of-scope) for the trust delegation.

**What we want from the audit.** Recommendation if the audit team
believes property-based tests in Rust (e.g. `proptest` for
`handle_chars_valid`) would catch a class of bug the existing tests
miss.

## K8. No formal verification

**Description.** The program is small enough that we considered
formal verification (e.g. via `kani` or hand-written proofs against
the Anchor account model). We chose not to do it for V1.

**Why we accept it.** The behaviour is mostly enforced by Anchor
constraint macros, not by program-internal logic. Verifying *Anchor*
is a much larger project than our V1 budget supports, and verifying
ZettaPay's tiny logic on top is low value without it.

**What we want from the audit.** A reasoned opinion on whether the
small surface and the Anchor reliance are sufficient, or whether
specific properties (PDA uniqueness, immutability) warrant a formal
proof.
