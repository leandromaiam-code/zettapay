# ZettaPay program

On-chain Solana program backing the Z9 immutable wallet binding.

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

## Why immutable

Per Z9, the chain is the source of truth for `(handle → owner, USDC payout account)`. Mutability would let a compromised owner key reroute future payments without the protocol observing the rotation, breaking the trust contract for downstream payers.

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

The TypeScript-side seed contract is exercised by the npm test suite — see
`packages/api/test/merchantBinding.test.ts`.
