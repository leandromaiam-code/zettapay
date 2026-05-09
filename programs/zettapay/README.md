# ZettaPay program

On-chain Solana program backing the Z9 immutable wallet bindings and
payment receipts.

## Instructions

### `register_merchant(merchant_handle, usdc_token_account)`

Creates an immutable `MerchantBinding` PDA at:

```
seeds = [merchant_handle.as_bytes(), owner.key().as_ref()]
```

Constraints enforced by the program:

- `merchant_handle` length in `3..=32` bytes
- `merchant_handle` matches `^[a-z0-9][a-z0-9_-]*$`
- `owner` must sign — preventing third parties from binding handles to wallets they don't control
- `payer` must sign — decoupled from `owner` so a facilitator can sponsor rent without holding any authority
- Re-registration of the same `(handle, owner)` is rejected by Anchor's `init` constraint (account already in use)

There is no `update_merchant` and no `close_merchant` instruction. The binding is once-and-forever.

### `record_payment(payment_id, amount, tx_signature)`

Creates an immutable `Payment` PDA at:

```
seeds = [merchant_binding.key().as_ref(), &payment_id]
```

Anchors a settled USDC transfer's `(amount, tx_signature)` proof against a
specific `MerchantBinding` account. Inputs:

- `payment_id: [u8; 32]` — opaque payment id (random bytes or a hash of an
  external invoice id). Acts as the second PDA seed and provides on-chain
  idempotency: the same `(merchant_binding, payment_id)` cannot be recorded
  twice.
- `amount: u64` — USDC base units (6 decimals). Strictly greater than zero.
- `tx_signature: [u8; 64]` — Ed25519 signature of the underlying USDC
  transfer transaction this receipt anchors.

Constraints enforced by the program:

- `merchant_binding` is validated as a real `MerchantBinding` account by
  Anchor's discriminator check — an arbitrary unrelated account cannot
  stand in.
- `amount` must be `> 0` (`AmountMustBePositive`).
- `payer` must sign and funds rent. **No other signer is required** —
  recording a receipt is intentionally permissionless so any facilitator
  (the merchant itself, an AI agent, an indexer) can anchor a settled
  transfer without holding any authority over the binding. The receipt is
  a proof, not an authorisation.
- Re-recording the same `(merchant_binding, payment_id)` is rejected by
  Anchor's `init` constraint.

There is no `update_payment` or `close_payment` instruction.

## Why immutable

Per Z9, the chain is the source of truth for both:

1. `(handle → owner, USDC payout account)` — so payers can always resolve a
   handle to its canonical wallet.
2. `(merchant, payment_id) → (amount, signature)` — so receipts can be
   verified without trusting any off-chain ledger.

Mutability would let a compromised owner key reroute future payments or
rewrite past receipts without the protocol observing the change, breaking
the trust contract for downstream payers and the AI-agent payment graph.

## Rebuilding the program ID

The committed `declare_id!` is the standard Anchor placeholder. After cloning:

```sh
anchor keys list
# replace declare_id! in lib.rs and the entries in Anchor.toml with the printed key
```

## Build & test

Local toolchain required (CI does not have Rust/Anchor installed):

```sh
anchor build
anchor test                  # spins up solana-test-validator
cargo test --manifest-path programs/zettapay/Cargo.toml   # pure-Rust unit tests
```

The TypeScript-side seed contracts are exercised by the npm test suite:

- `packages/api/test/merchantBinding.test.ts` — `register_merchant` PDA
- `packages/api/test/paymentRecord.test.ts` — `record_payment` PDA
