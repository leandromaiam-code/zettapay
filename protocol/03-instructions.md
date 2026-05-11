# 03 · Instructions

The ZettaPay program dispatches on the **leading byte** of
`instruction_data`. This is a single-byte discriminator (not Anchor's
8-byte sighash) — chosen to keep the wire format tight enough that any
client can encode an instruction by hand.

| Tag | Variant | Description |
| --- | --- | --- |
| `0` | [`RegisterMerchant`](#0--registermerchant) | Allocate the Merchant PDA + master binding |
| `1` | [`CreateInvoice`](#1--createinvoice) | Allocate the next Invoice PDA, increment counter |
| `2` | [`Sweep`](#2--sweep) | Flip a batch of Open invoices to Swept |

Every variant's payload is a Borsh-encoded argument struct appended
directly after the tag byte. Borsh is **borsh v0.10.3** (the version
exported by `solana-program 1.18.x`); newer borsh majors strip the
`Pubkey: BorshSerialize` impl and are not wire-compatible.

## 0 · RegisterMerchant

Allocates the Merchant PDA and writes the master binding. Idempotent
per `(master_pubkey, program_id)` — calling twice yields a "already in
use" failure from the system program at `create_account` time.

### Wire format

```
[ tag = 0x00 ]
[ borsh(RegisterMerchantArgs) = {
    master_pubkey: Pubkey,   // 32 bytes
    chains:        Vec<u8>,  // u32 length prefix + N bytes
} ]
```

| Arg | Type | Encoding | Constraints |
| --- | --- | --- | --- |
| `master_pubkey` | `Pubkey` | 32 raw bytes | MUST equal the signer key of account `[1]` |
| `chains` | `Vec<u8>` | u32 LE length + bytes | MUST contain `CHAIN_SOLANA = 0`. Length 1–`MAX_CHAINS` (= 16). Each byte one of `CHAIN_SOLANA`, `CHAIN_ETHEREUM`, `CHAIN_BASE`, `CHAIN_POLYGON`, `CHAIN_ARBITRUM`, `CHAIN_AVALANCHE`. |

### Accounts

| # | Name | Writable | Signer | Notes |
| --- | --- | --- | --- | --- |
| 0 | `merchant_pda` | ✅ | — | PDA `[b"merchant", master_pubkey]`; created by the instruction |
| 1 | `master` | — | ✅ | Authority for the merchant; key MUST equal `master_pubkey` arg |
| 2 | `payer` | ✅ | ✅ | Rent payer (often the same as master) |
| 3 | `system_program` | — | — | MUST equal `11111111111111111111111111111111` |

### Failure modes

| Error | When |
| --- | --- |
| `InvalidInstruction` | Payload fails Borsh decode |
| `ChainsEmpty` | `chains.is_empty()` |
| `ChainsTooLong` | `chains.len() > MAX_CHAINS` |
| `SolanaChainRequired` | `!chains.contains(CHAIN_SOLANA)` — Premise I.1 |
| `UnknownChain` | A byte in `chains` is outside the enumerated tags |
| `MasterMismatch` | `master.key != master_pubkey` |
| `MerchantPdaMismatch` | `merchant_pda.key` differs from `find_program_address` output |
| `MissingRequiredSignature` | `master` or `payer` did not sign |
| `IncorrectProgramId` | `system_program` is not the canonical system program |

Full error → `u32` code mapping: [`05-error-codes.md`](./05-error-codes.md).

### Reference encoding

```ts
import { serialize } from 'borsh';
import { PublicKey } from '@solana/web3.js';

const args = {
  master_pubkey: masterPubkey.toBuffer(),
  chains: Buffer.from([0]),    // CHAIN_SOLANA only
};
const schema = new Map([[
  Object, {
    kind: 'struct',
    fields: [
      ['master_pubkey', [32]],
      ['chains', ['u8']],
    ],
  },
]]);
const payload = Buffer.concat([
  Buffer.from([0x00]),              // tag
  Buffer.from(serialize(schema, args)),
]);
```

## 1 · CreateInvoice

Allocates the **next** Invoice PDA for the merchant and increments
`merchant.invoice_count`. The PDA's seeds use the current
`invoice_count` value before the increment; this is the address the
SDK predicted with [`deriveInvoicePda`](./02-derivation-paths.md).

### Wire format

```
[ tag = 0x01 ]
[ borsh(CreateInvoiceArgs) = {
    amount:   u64,           // 8 bytes LE, USDC base units (6 decimals)
    currency: u8,            // 1 byte; MUST be CURRENCY_USDC = 0 in V1
} ]
```

| Arg | Type | Encoding | Constraints |
| --- | --- | --- | --- |
| `amount` | `u64` | 8 bytes LE | MUST be > 0 |
| `currency` | `u8` | 1 byte | MUST equal `CURRENCY_USDC = 0` — Premise I.2 |

### Accounts

| # | Name | Writable | Signer | Notes |
| --- | --- | --- | --- | --- |
| 0 | `merchant_pda` | ✅ | — | The existing Merchant account; owner MUST be the program; `invoice_count` is incremented |
| 1 | `master` | — | ✅ | Key MUST equal `merchant.master_pubkey` |
| 2 | `invoice_pda` | ✅ | — | PDA `[master_pubkey, u64_le(merchant.invoice_count)]`; created by the instruction |
| 3 | `payer` | ✅ | ✅ | Rent payer |
| 4 | `system_program` | — | — | Canonical system program |

### Failure modes

| Error | When |
| --- | --- |
| `InvalidInstruction` | Borsh decode failure |
| `AmountZero` | `amount == 0` |
| `CurrencyUnsupported` | `currency != CURRENCY_USDC` |
| `NotMerchantAccount` | `merchant_pda` is not a Merchant (tag byte ≠ 1) |
| `MasterMismatch` | `master.key != merchant.master_pubkey` |
| `InvoicePdaMismatch` | `invoice_pda` differs from the program-derived address |
| `Overflow` | `merchant.invoice_count + 1` overflows `u64` (~ 1.8 × 10¹⁹ invoices; effectively unreachable) |
| `IllegalOwner` | `merchant_pda` is not owned by the program |

## 2 · Sweep

Flips a batch of `Open` invoices to `Swept`. Does **not** move USDC —
settlement is a separate SPL `transferChecked` flow. The on-chain
status is the merchant's "I have observed this payment" marker.

### Wire format

```
[ tag = 0x02 ]
[ borsh(SweepArgs) = {
    invoice_indexes: Vec<u64>,   // u32 LE length + N×8 bytes LE
} ]
```

| Arg | Type | Encoding | Constraints |
| --- | --- | --- | --- |
| `invoice_indexes` | `Vec<u64>` | u32 LE length + 8 LE bytes per entry | Non-empty. Each index < `merchant.invoice_count`. |

### Accounts

| # | Name | Writable | Signer | Notes |
| --- | --- | --- | --- | --- |
| 0 | `merchant_pda` | — | — | Read-only; owner MUST be the program |
| 1 | `master` | — | ✅ | Key MUST equal `merchant.master_pubkey` |
| 2..N+1 | invoice accounts | ✅ | — | One Invoice PDA per index, in the same order as `invoice_indexes` |

> **Account-count invariant.** The number of invoice accounts after
> `master` must equal `invoice_indexes.len()`. A mismatch returns
> `AccountInvoiceCountMismatch` rather than being silently truncated —
> partial sweeps are not a thing.

### Status transitions

```
[Open] ─ Sweep ─▶ [Swept]
   │
   └─ already Swept → InvoiceNotOpen
```

The transition is one-way. There is no `Unsweep`. A merchant who
swept the wrong invoice handles it off-chain (a refund USDC transfer
in the opposite direction).

### Failure modes

| Error | When |
| --- | --- |
| `InvalidInstruction` | Borsh decode failure |
| `NoInvoices` | `invoice_indexes.is_empty()` |
| `AccountInvoiceCountMismatch` | Account list length ≠ index list length |
| `NotMerchantAccount` | `merchant_pda` tag byte ≠ 1 |
| `MasterMismatch` | `master.key != merchant.master_pubkey` |
| `NotInvoiceAccount` | An invoice account's tag byte ≠ 2 |
| `InvoicePdaMismatch` | An invoice account's address differs from its derived PDA |
| `InvoiceMerchantMismatch` | `invoice.merchant != merchant_pda.key` |
| `InvoiceNotOpen` | `invoice.status != INVOICE_STATUS_OPEN` |
| `IllegalOwner` | Any account not owned by the program |

## Chain tags reference

| Constant | Value | V1 status |
| --- | --- | --- |
| `CHAIN_SOLANA` | `0` | Required, settlement chain |
| `CHAIN_ETHEREUM` | `1` | Declared-only; settlement gated on Z11 |
| `CHAIN_BASE` | `2` | Declared-only; settlement gated on Z11 |
| `CHAIN_POLYGON` | `3` | Declared-only; settlement gated on Z11 |
| `CHAIN_ARBITRUM` | `4` | Declared-only; settlement gated on Z11 |
| `CHAIN_AVALANCHE` | `5` | Declared-only; settlement gated on Z11 |

V1 enforces Solana as the only settlement chain; the non-Solana tags
are recorded on the merchant so a future Z11 multi-chain router can
read the declared set without forcing re-registration.

## Currency tags reference

| Constant | Value | V1 status |
| --- | --- | --- |
| `CURRENCY_USDC` | `0` | Required (Premise I.2). |

Additional stablecoin tags are reserved but not yet defined.
