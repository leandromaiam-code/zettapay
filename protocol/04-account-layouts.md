# 04 · Account layouts

Both program-owned account types are **fixed-size** Borsh structs. The
first byte of every account is a one-byte **tag** identifying the type
— a cheaper substitute for Anchor's 8-byte discriminator that lets the
program reject a wrong-type account before any Borsh decode runs.

| Tag | Constant | Account |
| --- | --- | --- |
| `1` | `MERCHANT_TAG` | [Merchant](#1--merchant) |
| `2` | `INVOICE_TAG` | [Invoice](#2--invoice) |

Sizes are fixed so `system_instruction::create_account` can pass the
size verbatim. Variable-length fields (e.g. `chains: Vec<u8>` on
Merchant) carry a hard cap so the worst-case Borsh encoding still fits
the allocated buffer.

## 1 · Merchant

```rust
pub struct Merchant {
    pub tag:            u8,          //  1
    pub bump:           u8,          //  1
    pub master_pubkey:  Pubkey,      // 32
    pub chains:         Vec<u8>,     //  4 + MAX_CHAINS (= 4 + 16 = 20)
    pub invoice_count:  u64,         //  8
    pub registered_at:  i64,         //  8
}
// SIZE = 1 + 1 + 32 + (4 + 16) + 8 + 8 = 74 bytes
```

| Offset | Field | Width | Notes |
| --- | --- | --- | --- |
| `0` | `tag` | 1 | Always `MERCHANT_TAG = 1` |
| `1` | `bump` | 1 | PDA bump from `find_merchant_pda` |
| `2` | `master_pubkey` | 32 | Master signer; raw 32-byte pubkey |
| `34` | `chains.length` | 4 | Borsh `Vec<u8>` prefix, little-endian `u32` |
| `38` | `chains.bytes` | variable, ≤ 16 | One byte per registered chain tag |
| `38 + chains.length` | `invoice_count` | 8 | LE `u64`; monotonic, next invoice's seed |
| `…+8` | `registered_at` | 8 | LE `i64`; Solana clock at registration |

Because the in-rent allocation is fixed at `Merchant::SIZE = 74`, any
`chains` shorter than `MAX_CHAINS` leaves padding bytes after the
Borsh struct ends. The program reads via `Merchant::try_from_slice`
which respects the Borsh length prefix and ignores the trailing
padding.

### Constants

```rust
pub const MERCHANT_TAG:   u8    = 1;
pub const MAX_CHAINS:     usize = 16;

pub const CHAIN_SOLANA:    u8 = 0;
pub const CHAIN_ETHEREUM:  u8 = 1;
pub const CHAIN_BASE:      u8 = 2;
pub const CHAIN_POLYGON:   u8 = 3;
pub const CHAIN_ARBITRUM:  u8 = 4;
pub const CHAIN_AVALANCHE: u8 = 5;

impl Merchant {
    pub const SIZE: usize = 1 + 1 + 32 + (4 + MAX_CHAINS) + 8 + 8;
}
```

### TypeScript decoder

```ts
import { PublicKey } from '@solana/web3.js';

export interface Merchant {
  tag: number;
  bump: number;
  masterPubkey: PublicKey;
  chains: number[];
  invoiceCount: bigint;
  registeredAt: bigint;
}

export function decodeMerchant(data: Buffer): Merchant {
  let off = 0;
  const tag = data.readUInt8(off); off += 1;
  if (tag !== 1) throw new Error('not a Merchant account');
  const bump = data.readUInt8(off); off += 1;
  const masterPubkey = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const chainsLen = data.readUInt32LE(off); off += 4;
  const chains = Array.from(data.subarray(off, off + chainsLen)); off += chainsLen;
  const invoiceCount = data.readBigUInt64LE(off); off += 8;
  const registeredAt = data.readBigInt64LE(off); off += 8;
  return { tag, bump, masterPubkey, chains, invoiceCount, registeredAt };
}
```

## 2 · Invoice

```rust
pub struct Invoice {
    pub tag:           u8,         //  1
    pub bump:          u8,         //  1
    pub merchant:      Pubkey,     // 32
    pub invoice_index: u64,        //  8
    pub amount:        u64,        //  8
    pub currency:      u8,         //  1
    pub status:        u8,         //  1
    pub created_at:    i64,        //  8
    pub swept_at:      i64,        //  8
}
// SIZE = 1 + 1 + 32 + 8 + 8 + 1 + 1 + 8 + 8 = 67 bytes
```

| Offset | Field | Width | Notes |
| --- | --- | --- | --- |
| `0` | `tag` | 1 | Always `INVOICE_TAG = 2` |
| `1` | `bump` | 1 | PDA bump from `find_invoice_pda` |
| `2` | `merchant` | 32 | The owning Merchant PDA address |
| `34` | `invoice_index` | 8 | LE `u64`; matches the seed used to derive this PDA |
| `42` | `amount` | 8 | LE `u64`; USDC base units (6 decimals) |
| `50` | `currency` | 1 | `CURRENCY_USDC = 0` in V1 |
| `51` | `status` | 1 | `INVOICE_STATUS_OPEN = 0` or `INVOICE_STATUS_SWEPT = 1` |
| `52` | `created_at` | 8 | LE `i64`; Solana clock at creation |
| `60` | `swept_at` | 8 | LE `i64`; `0` while `status == Open`, set on Sweep |

### Constants

```rust
pub const INVOICE_TAG:           u8 = 2;
pub const INVOICE_STATUS_OPEN:   u8 = 0;
pub const INVOICE_STATUS_SWEPT:  u8 = 1;
pub const CURRENCY_USDC:         u8 = 0;

impl Invoice {
    pub const SIZE: usize = 1 + 1 + 32 + 8 + 8 + 1 + 1 + 8 + 8;
}
```

### TypeScript decoder

```ts
import { PublicKey } from '@solana/web3.js';

export interface Invoice {
  tag: number;
  bump: number;
  merchant: PublicKey;
  invoiceIndex: bigint;
  amount: bigint;
  currency: number;
  status: number;
  createdAt: bigint;
  sweptAt: bigint;
}

export function decodeInvoice(data: Buffer): Invoice {
  if (data.length < 67) throw new Error('invoice account too short');
  let off = 0;
  const tag = data.readUInt8(off); off += 1;
  if (tag !== 2) throw new Error('not an Invoice account');
  const bump = data.readUInt8(off); off += 1;
  const merchant = new PublicKey(data.subarray(off, off + 32)); off += 32;
  const invoiceIndex = data.readBigUInt64LE(off); off += 8;
  const amount = data.readBigUInt64LE(off); off += 8;
  const currency = data.readUInt8(off); off += 1;
  const status = data.readUInt8(off); off += 1;
  const createdAt = data.readBigInt64LE(off); off += 8;
  const sweptAt = data.readBigInt64LE(off); off += 8;
  return {
    tag, bump, merchant, invoiceIndex, amount, currency, status,
    createdAt, sweptAt,
  };
}
```

## Rent

Both account sizes are well under the 10,240-byte PDA hard cap. The
program uses `Rent::get()?.minimum_balance(SIZE)` at allocation time;
SDK callers don't need to compute rent themselves — the system
program will be debited from the `payer` account when `create_account`
runs.

| Account | Bytes | Approx. rent (lamports, mainnet 2025-ish) |
| --- | --- | --- |
| Merchant | 74 | ~ 1,343,520 (~ 0.00134 SOL) |
| Invoice | 67 | ~ 1,294,800 (~ 0.00129 SOL) |

Lamport figures are illustrative — rent is set by the cluster's
`Rent` sysvar and changes when SOL price-targeting parameters are
updated. Always read the current value at runtime.

## Endianness

Every multi-byte field is **little-endian**. This is true for `u32`,
`u64`, and `i64` alike, and it matches both the Borsh
`v0.10.3` encoding and the PDA seed conventions described in
[`02-derivation-paths.md`](./02-derivation-paths.md).
