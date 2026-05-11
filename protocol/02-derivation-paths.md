# 02 · Derivation paths

ZettaPay derives every owned account as a Program-Derived Address
(PDA). The seed schemes are part of the wire contract: a client that
derives a different address than the on-chain program quotes a wrong
account and the program returns a structured PDA-mismatch error.

Both the canonical Rust implementation
([`programs/zettapay-core/src/pda.rs`](../programs/zettapay-core/src/pda.rs))
and the off-chain TypeScript helper must produce **byte-for-byte
identical** PDAs. The integration tests in `pda.rs` and `helpers.test.ts`
pin this parity.

## 1. Merchant PDA

A merchant's on-chain identity is one PDA per master signer.

| Aspect | Value |
| --- | --- |
| Seeds | `[b"merchant", master_pubkey]` |
| Seed prefix constant | `MERCHANT_SEED = b"merchant"` (8 bytes) |
| `master_pubkey` | The merchant's master wallet (signer; matches `master_pubkey` field on `RegisterMerchant`) |
| Bump | Stored in `Merchant.bump` at registration; required by `invoke_signed` |

### Rust (canonical)

```rust
pub const MERCHANT_SEED: &[u8] = b"merchant";

pub fn find_merchant_pda(
    master_pubkey: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[MERCHANT_SEED, master_pubkey.as_ref()],
        program_id,
    )
}
```

### TypeScript (parity)

```ts
import { PublicKey } from '@solana/web3.js';

export const MERCHANT_SEED = Buffer.from('merchant', 'utf8');

export function deriveMerchantPda(
  masterPubkey: PublicKey,
  programId: PublicKey,
): { pda: PublicKey; bump: number } {
  const [pda, bump] = PublicKey.findProgramAddressSync(
    [MERCHANT_SEED, masterPubkey.toBuffer()],
    programId,
  );
  return { pda, bump };
}
```

### Why a literal prefix?

The `b"merchant"` prefix is the structural guard against an
`[master_pubkey, x]` invoice seed colliding with a `[b"merchant",
master_pubkey]` merchant seed. The ASCII bytes of `"merchant"` cannot
be the first 8 bytes of any ed25519 pubkey the SDK could produce —
the leading byte of any base58-decoded `Pubkey` is uniformly random
over 256 values, so the prefix dichotomy is structurally enforced.

The on-chain unit test
[`pda::tests::invoice_pda_cannot_collide_with_merchant_pda_for_same_master`](../programs/zettapay-core/src/pda.rs)
pins this property.

## 2. Invoice PDA

Invoices are derived from the merchant's master signer and a monotonic
`u64` index. The merchant's `invoice_count` field stores the **next**
index to assign; `CreateInvoice` consumes the current value and
increments.

| Aspect | Value |
| --- | --- |
| Seeds | `[master_pubkey, u64_le(invoice_index)]` |
| `invoice_index` | `u64`, **little-endian** 8 bytes |
| Seed-length constant | `INVOICE_INDEX_SEED_LEN = 8` |
| Bump | Stored in `Invoice.bump` at creation |

### Rust (canonical)

```rust
pub const INVOICE_INDEX_SEED_LEN: usize = 8;

pub fn find_invoice_pda(
    master_pubkey: &Pubkey,
    invoice_index: u64,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    let index_seed = invoice_index.to_le_bytes();
    Pubkey::find_program_address(
        &[master_pubkey.as_ref(), &index_seed],
        program_id,
    )
}
```

### TypeScript (parity)

```ts
import { PublicKey } from '@solana/web3.js';

export const INVOICE_INDEX_SEED_LEN = 8;

export function deriveInvoicePda(
  masterPubkey: PublicKey,
  invoiceIndex: bigint,
  programId: PublicKey,
): { pda: PublicKey; bump: number } {
  const indexSeed = Buffer.alloc(INVOICE_INDEX_SEED_LEN);
  indexSeed.writeBigUInt64LE(invoiceIndex);

  const [pda, bump] = PublicKey.findProgramAddressSync(
    [masterPubkey.toBuffer(), indexSeed],
    programId,
  );
  return { pda, bump };
}
```

### Why little-endian?

Solana's runtime is little-endian; Borsh's `u64` encoding is
little-endian; `Buffer.writeBigUInt64LE` in the SDK is little-endian.
Aligning the PDA seed encoding to those keeps the entire payment
pipeline endian-consistent end to end. The on-chain test
[`pda::tests::invoice_pda_uses_little_endian_index`](../programs/zettapay-core/src/pda.rs)
spot-checks `idx = 256` against its hand-encoded LE seed; if the
program ever switched to big-endian, only indices ≥ 256 would diverge,
which is exactly the kind of silent drift this test exists to catch.

## 3. Address predictability

The invoice PDA is fully determined by `(master_pubkey, invoice_index,
program_id)`. Because the next `invoice_index` is published as part of
the merchant account's `invoice_count` field, the SDK can predict the
PDA of the **next** invoice without first calling `CreateInvoice`.

This is what lets `embed.js` and the widget render a QR — with the
invoice PDA as the Solana Pay `reference` — at the moment the user
clicks **Pay**, then call `CreateInvoice` and poll for status in
parallel. Without address predictability, the QR would have to wait on
a round-trip to the chain.

### Worked example

```ts
import { Connection, PublicKey } from '@solana/web3.js';
// import { deriveMerchantPda, deriveInvoicePda, MERCHANT_ACCOUNT_LAYOUT } from '...';

async function nextInvoicePda(
  conn: Connection,
  masterPubkey: PublicKey,
  programId: PublicKey,
) {
  const { pda: merchantPda } = deriveMerchantPda(masterPubkey, programId);
  const info = await conn.getAccountInfo(merchantPda);
  if (!info) throw new Error('merchant not registered');

  // invoice_count lives at offset 1 (tag) + 1 (bump) + 32 (master)
  //                            + 4 + chains.len (Vec prefix + bytes).
  // Use the layout helper from `04-account-layouts.md`.
  const merchant = MERCHANT_ACCOUNT_LAYOUT.decode(info.data);

  return deriveInvoicePda(
    masterPubkey,
    merchant.invoice_count,
    programId,
  );
}
```

A wallet calling this against a known merchant gets the invoice PDA
that **will** be allocated on the next `CreateInvoice`, including the
correct bump. The on-chain handler re-derives the same address and
fails with `InvoicePdaMismatch` if the off-chain client and the chain
ever disagree.

## 4. Drift detection

The Z25.2 split between `state.rs`, `pda.rs`, `validation.rs`,
`instructions.rs`, and `error.rs` keeps drift surface minimal, but
several invariants must hold simultaneously across the on-chain and
off-chain halves. The full list, with the test that pins each:

| Invariant | Pinned by |
| --- | --- |
| `MERCHANT_SEED` is exactly `b"merchant"` (8 ASCII bytes) | `pda::tests::merchant_pda_is_deterministic` |
| Invoice index seed is `u64.to_le_bytes()` (8 bytes) | `pda::tests::invoice_pda_uses_little_endian_index` |
| `INVOICE_INDEX_SEED_LEN == size_of::<u64>()` | `pda::tests::invoice_index_seed_len_matches_u64_width` |
| Merchant and Invoice PDAs cannot collide for same master | `pda::tests::invoice_pda_cannot_collide_with_merchant_pda_for_same_master` |
| Dispatcher `invoke_signed` seeds match `find_*_pda` | `integration_tests::merchant_pda_seeds_match_module_constant`, `invoice_pda_seeds_match_le_u64_encoding` |

A failure on any of these is the canonical signal that on-chain and
off-chain derivations have diverged.
