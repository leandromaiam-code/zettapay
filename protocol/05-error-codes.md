# 05 · Error codes

The program returns errors as `ProgramError::Custom(u32)`. The custom
code is the **integer position** of the `ZpError` variant in
[`programs/zettapay-core/src/error.rs`](../programs/zettapay-core/src/error.rs).

Variant order is part of the wire contract. **Append-only**: new
variants land at the bottom. Reordering or inserting in the middle
silently shifts every downstream code and breaks every off-chain
decoder built against the previous order. The unit test
[`error::tests::discriminator_order_is_pinned`](../programs/zettapay-core/src/error.rs)
pins anchor codes (`0`, `1`, `2`, `3`, `16`) so a reorder trips the
build before it ships.

## Table

| Code | Variant | When |
| --- | --- | --- |
| `0` | `InvalidInstruction` | Empty `instruction_data`, unknown tag byte, or Borsh decode failure on the args |
| `1` | `MasterMismatch` | `master.key` differs from the master pubkey the instruction references (arg or merchant field) |
| `2` | `MerchantPdaMismatch` | The supplied merchant account is not the PDA derived from `[b"merchant", master_pubkey]` |
| `3` | `InvoicePdaMismatch` | The supplied invoice account is not the PDA derived from `[master_pubkey, u64_le(index)]` |
| `4` | `ChainsEmpty` | `RegisterMerchant` called with an empty `chains` vector |
| `5` | `ChainsTooLong` | `chains.len() > MAX_CHAINS (= 16)` |
| `6` | `SolanaChainRequired` | `chains` does not contain `CHAIN_SOLANA = 0` (Premise I.1) |
| `7` | `UnknownChain` | A byte in `chains` is outside the enumerated `CHAIN_*` tags |
| `8` | `CurrencyUnsupported` | `CreateInvoice` `currency != CURRENCY_USDC = 0` (Premise I.2) |
| `9` | `AmountZero` | `CreateInvoice` `amount == 0` |
| `10` | `NotMerchantAccount` | A merchant-typed slot's first byte is not `MERCHANT_TAG = 1` |
| `11` | `NotInvoiceAccount` | An invoice-typed slot's first byte is not `INVOICE_TAG = 2` |
| `12` | `InvoiceMerchantMismatch` | The `Invoice.merchant` field does not match the `merchant_pda` account |
| `13` | `InvoiceNotOpen` | `Sweep` attempted on an invoice with `status != INVOICE_STATUS_OPEN` |
| `14` | `NoInvoices` | `Sweep` called with an empty `invoice_indexes` vector |
| `15` | `AccountInvoiceCountMismatch` | `Sweep` invoice-account count ≠ `invoice_indexes.len()` |
| `16` | `Overflow` | Arithmetic overflow — currently only `merchant.invoice_count + 1` overflowing `u64` |

## Reading errors from off-chain

The `Custom(u32)` is wrapped inside a `TransactionError::InstructionError(idx, InstructionError::Custom(code))`. A
TypeScript decoder:

```ts
import type { TransactionError } from '@solana/web3.js';

const Z_P_ERROR = [
  'InvalidInstruction',
  'MasterMismatch',
  'MerchantPdaMismatch',
  'InvoicePdaMismatch',
  'ChainsEmpty',
  'ChainsTooLong',
  'SolanaChainRequired',
  'UnknownChain',
  'CurrencyUnsupported',
  'AmountZero',
  'NotMerchantAccount',
  'NotInvoiceAccount',
  'InvoiceMerchantMismatch',
  'InvoiceNotOpen',
  'NoInvoices',
  'AccountInvoiceCountMismatch',
  'Overflow',
] as const;

export function decodeZpError(err: TransactionError | null): string | null {
  if (!err || typeof err !== 'object') return null;
  const ix = (err as { InstructionError?: [number, { Custom?: number }] })
    .InstructionError;
  if (!ix) return null;
  const code = ix[1]?.Custom;
  if (code === undefined) return null;
  return Z_P_ERROR[code] ?? `UnknownZpError(${code})`;
}
```

## Standard Solana errors (not in the table)

These come from `solana-program` itself, not from `ZpError`. They are
*not* in the `Custom(u32)` numbering space — clients see them with
their canonical names (`IllegalOwner`, `MissingRequiredSignature`,
`IncorrectProgramId`, etc.). The relevant ones the program emits via
the validation helpers in
[`programs/zettapay-core/src/validation.rs`](../programs/zettapay-core/src/validation.rs):

| Source | When |
| --- | --- |
| `ProgramError::IllegalOwner` | A supposedly program-owned account is owned by another program (`assert_owned_by_program`) |
| `ProgramError::MissingRequiredSignature` | An account expected to sign did not (`assert_signer`) |
| `ProgramError::IncorrectProgramId` | The `system_program` slot is not the canonical system program (`assert_system_program`) |

Treat these as orthogonal to `ZpError` — they signal structural
problems with the supplied account set, not protocol-level rule
violations.

## Stability guarantees

- **Patch / minor releases** MAY append a new variant at the bottom
  of the enum. Off-chain decoders that fall back to
  `UnknownZpError(${code})` continue to work.
- **Patch / minor releases** MUST NOT reorder, delete, or rename
  variants. Renames are acceptable only when the integer code stays
  fixed.
- A major release that needs to reorder variants requires a new
  Program ID and a new IDL — see the SemVer table in [`README.md`](./README.md#versioning).
