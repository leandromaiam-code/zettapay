# ZettaPay Protocol Spec

> The open wire-level specification for the ZettaPay payment protocol on
> Solana. Vendored as a self-contained reference so SDK authors,
> wallet integrators, and indexers can build interoperable clients without
> reading the canonical Rust source.

This document set is the public mirror of what will be published at
**`github.com/zettapay/protocol`**. The canonical implementation lives in
this monorepo at [`programs/zettapay-core/`](../programs/zettapay-core/);
this spec is normative for off-chain integrators.

## Program IDs

| Cluster | Program ID | Status |
| --- | --- | --- |
| **mainnet-beta** | _TBD — assigned at Z22.1 mainnet cutover_ | Pending |
| **devnet** | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` | Live |
| **localnet** | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` | Anchor.toml default |

> The mainnet ID is announced in this README once the launch checklist
> (Z21 audit + Z22 cutover) is signed off. Until then, treat any "mainnet"
> claim quoting an address other than the value published here as
> unofficial.

### Canonical token mints (USDC, V1)

| Cluster | USDC Mint |
| --- | --- |
| mainnet-beta | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| devnet | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |

V1 settles in USDC only (Premise I.2). Other stablecoins gate on Z11.

## Table of contents

| # | Section | What it covers |
| --- | --- | --- |
| 00 | [Overview](./00-overview.md) | Design goals, premises mapping, threat model |
| 01 | [URI schemes](./01-uri-scheme.md) | `zettapay:` and `solana:` URI formats with examples |
| 02 | [Derivation paths](./02-derivation-paths.md) | Merchant + Invoice PDA seeds, off-chain parity |
| 03 | [Instructions](./03-instructions.md) | Discriminators, Borsh args, account orderings |
| 04 | [Account layouts](./04-account-layouts.md) | Fixed-size Borsh layouts for Merchant + Invoice |
| 05 | [Error codes](./05-error-codes.md) | `ZpError` → `ProgramError::Custom(u32)` table |
| 06 | [Proof formats](./06-proof-formats.md) | x402 header proof + on-chain settlement proof |

## At a glance

ZettaPay exposes **three instructions** dispatched by a single-byte
discriminator at the head of `instruction_data`:

| Tag | Instruction | Purpose |
| --- | --- | --- |
| `0` | `RegisterMerchant` | Mint a merchant PDA bound to a master signer + declared chain set |
| `1` | `CreateInvoice` | Allocate a deterministic invoice PDA at the next monotonic index |
| `2` | `Sweep` | Flip a batch of open invoices to `Swept` status (no USDC moves) |

Two account types are owned by the program:

| Tag | Account | Seeds | Size |
| --- | --- | --- | --- |
| `1` | `Merchant` | `[b"merchant", master_pubkey]` | 74 bytes |
| `2` | `Invoice` | `[master_pubkey, u64_le(invoice_index)]` | 67 bytes |

USDC settlement is **never custodial** — `transferChecked` flows payer →
merchant ATA directly. The on-chain invoice acts as a receipt anchor,
not as an escrow.

## Quick example — derive an invoice PDA

The invoice PDA is the canonical handle a payer scans, a wallet quotes,
and an indexer correlates against. Both on-chain and off-chain code use
the same seed scheme (`[master_pubkey, u64_le(invoice_index)]`).

```ts
import { PublicKey } from '@solana/web3.js';

const PROGRAM_ID = new PublicKey(
  'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS', // devnet
);

function deriveInvoicePda(
  masterPubkey: PublicKey,
  invoiceIndex: bigint,
): { pda: PublicKey; bump: number } {
  const indexSeed = Buffer.alloc(8);
  indexSeed.writeBigUInt64LE(invoiceIndex);

  const [pda, bump] = PublicKey.findProgramAddressSync(
    [masterPubkey.toBuffer(), indexSeed],
    PROGRAM_ID,
  );
  return { pda, bump };
}
```

```rust
// On-chain — programs/zettapay-core/src/pda.rs
use solana_program::pubkey::Pubkey;

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

The two derivations are required to agree byte-for-byte. See
[`02-derivation-paths.md`](./02-derivation-paths.md) for the full seed
contract.

## Quick example — issue a payment URI

```ts
import { buildZettaPayUri, buildSolanaPayUri } from '@zettapay/sdk';

// ZettaPay-native URI — keyed on the invoice PDA
const zp = buildZettaPayUri({
  invoicePda: '8x...',           // base58, derived above
  amount: '29.00',
  currency: 'USDC',
  label: 'Acme Coffee',
  message: 'Order #4421',
});
// → "zettapay:invoice/8x...?amount=29.00&currency=USDC&..."

// Solana Pay URI — accepted by Phantom, Solflare, Backpack, Glow, …
const sp = buildSolanaPayUri({
  recipient: 'MERCHANT_WALLET_PUBKEY',
  amount: '29.00',
  splToken: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC mainnet
  reference: ['8x...'],          // invoice PDA used as correlation handle
  label: 'Acme Coffee',
  message: 'Order #4421',
});
// → "solana:MERCHANT_WALLET_PUBKEY?amount=29.00&spl-token=EPjFW...&reference=8x..."
```

Spec details and parser semantics: [`01-uri-scheme.md`](./01-uri-scheme.md).

## Quick example — pay as an AI agent (x402)

```ts
import { Connection, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction } from '@solana/spl-token';

const tx = new Transaction({
  feePayer: payer.publicKey,
  recentBlockhash: (await conn.getLatestBlockhash()).blockhash,
});
tx.add(createTransferCheckedInstruction(
  payerAta, USDC_MINT, merchantAta, payer.publicKey,
  BigInt(amountUsdc * 1_000_000), 6,
));
tx.sign(payer);

await fetch('https://api.zettapay.io/pay', {
  method: 'POST',
  headers: {
    'x-zettapay-api-key': API_KEY,
    'x-402-payment': tx.serialize().toString('base64'),
  },
  body: JSON.stringify({ merchantId: 42, amount: amountUsdc.toFixed(2) }),
});
```

Full validation rules and failure codes: [`06-proof-formats.md`](./06-proof-formats.md).

## Versioning

This spec follows the same SemVer-ish cadence as the on-chain program.
The version is the leading line of [`VERSION`](./VERSION). Breaking
changes — instruction discriminators, account layouts, PDA seeds — are
**not** patch-level: they require a major bump and a new Program ID.

| Change class | Allowed in patch? | Allowed in minor? | Requires major? |
| --- | --- | --- | --- |
| Doc clarification | ✅ | ✅ | — |
| Adding a new instruction | — | ✅ | — |
| Appending an error variant | — | ✅ | — |
| Reordering error variants | ❌ | ❌ | ✅ |
| Changing a PDA seed | ❌ | ❌ | ✅ |
| Reordering account inputs | ❌ | ❌ | ✅ |

## Status & contributions

The spec is MIT-licensed (see [`../LICENSE`](../LICENSE), per
Premise X.31). SDK ports, wallet integrations, and indexer
implementations against this spec are welcome — open a PR against this
repo or against the upstream `github.com/zettapay/protocol` mirror once
it is published.

For protocol-level discussions and SDK author Q&A, the canonical channel
is the `#api` room of the ZettaPay Discord (see
[`../community/discord/`](../community/discord/README.md)).
