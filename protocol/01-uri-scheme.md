# 01 · URI schemes

ZettaPay ships **two** URI flavours side by side. Both encode the same
payment request; they differ in what they assume about the wallet on
the receiving end.

| Scheme | Audience | Primary identifier |
| --- | --- | --- |
| `zettapay:` | ZettaPay-aware wallets, the embed.js polling client | Invoice PDA |
| `solana:` | Any wallet that speaks the Solana Pay spec | Merchant wallet pubkey |

Issuers SHOULD render both when surfacing a QR (one as the scanned
payload, the other in a "copy URL" fallback). Wallets MUST accept the
scheme they advertise support for; they MAY accept the other.

## 1. The `zettapay:` scheme

The ZettaPay-native scheme is keyed on the **deterministic invoice PDA**.
The PDA alone is enough for a watcher to query on-chain state and confirm
settlement without trusting any off-chain index.

### Grammar (ABNF, normative)

```abnf
zettapay-uri    = "zettapay:" "invoice" "/" pda [ "?" query ]
pda             = 1*base58char            ; ed25519 pubkey, 43–44 chars
query           = parameter *( "&" parameter )
parameter       = key "=" *( pchar )
key             = "amount" / "currency" / "label" / "message" / "memo"
                / ext-key
ext-key         = "x-" 1*ALPHA            ; vendor extensions, MUST start with "x-"
base58char      = %x31-39 / %x41-48 / %x4A-4E / %x50-5A / %x61-6B / %x6D-7A
pchar           = unreserved / pct-encoded / sub-delims / ":" / "@"
                ; RFC 3986
```

### Parameters

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `amount` | decimal string | no | Human units (e.g. `"29.00"`). MUST match `^-?\d+(\.\d+)?$`. MUST be > 0. |
| `currency` | symbol | no | Defaults to `USDC`. V1 accepts only `USDC`. |
| `label` | UTF-8 | no | Merchant display name. |
| `message` | UTF-8 | no | Short payer-facing memo ("Order #4421"). |
| `memo` | UTF-8 | no | Persisted alongside the on-chain transfer; reflected in the SPL memo program. |
| `x-*` | UTF-8 | no | Vendor extensions. Unknown `x-` keys MUST be ignored, not rejected. |

`amount` is encoded as a decimal string (not base units) so payers see
the same number their wallet quotes them. The on-chain `Invoice.amount`
is in USDC base units (6 decimals), separately Borsh-encoded; the URI
remains human-readable.

### Example

```
zettapay:invoice/8x7yA1mTpqEYbF7QvCk9oCk5w9wkrLwQbk8GDhWqkqGr?amount=29.00&currency=USDC&label=Acme%20Coffee&message=Order%20%234421
```

Decoded:

| Field | Value |
| --- | --- |
| `invoicePda` | `8x7yA1mTpqEYbF7QvCk9oCk5w9wkrLwQbk8GDhWqkqGr` |
| `amount` | `"29.00"` |
| `currency` | `"USDC"` |
| `label` | `"Acme Coffee"` |
| `message` | `"Order #4421"` |
| `memo` | `null` |

### Parser semantics

A conforming `zettapay:` parser MUST:

1. Lowercase-compare the scheme (`zettapay`). Reject any other.
2. Verify the resource segment is exactly `invoice`. Reject otherwise.
3. Round-trip the PDA through ed25519 base58 decoding. Reject malformed
   pubkeys.
4. Treat `amount` (when present) as a decimal string. Reject negative
   or zero amounts. Do not silently coerce floats — preserve the
   original string for display.
5. Default `currency` to `"USDC"` when absent.
6. Preserve unknown `x-` parameters verbatim for forward compatibility.

The TypeScript reference implementation lives in
[`../packages/sdk/src/solana-pay.ts`](../packages/sdk/src/solana-pay.ts)
(`buildZettaPayUri` / `parseZettaPayUri`).

## 2. The `solana:` scheme (Solana Pay)

ZettaPay emits the standard Solana Pay transfer-request URI per the
spec at <https://docs.solanapay.com/spec>. Any Solana Pay-compatible
wallet (Phantom, Solflare, Backpack, Glow, …) can scan the resulting
QR and settle the same invoice without ZettaPay-specific code.

### Grammar (reference; normative source is the upstream Solana Pay spec)

```abnf
solana-uri      = "solana:" recipient [ "?" query ]
recipient       = 1*base58char            ; merchant wallet pubkey, NOT an ATA
query           = parameter *( "&" parameter )
parameter       = "amount" "=" decimal
                / "spl-token" "=" base58
                / "reference" "=" base58  ; MAY repeat
                / "label" "=" *( pchar )
                / "message" "=" *( pchar )
                / "memo" "=" *( pchar )
```

### ZettaPay conventions

The Solana Pay spec leaves several fields wallet-defined; ZettaPay
narrows them as follows:

| Field | Convention |
| --- | --- |
| `recipient` | The merchant's master wallet pubkey. Wallets derive the USDC ATA. |
| `spl-token` | The canonical USDC mint for the target cluster (see [`README.md`](./README.md#canonical-token-mints-usdc-v1)). |
| `reference` | The **invoice PDA**. This is how an indexer correlates the on-chain transfer back to a ZettaPay invoice without needing a merchant lookup. |
| `amount` | Same decimal-string semantics as the `zettapay:` scheme. |
| `label`, `message`, `memo` | Identical semantics to `zettapay:`. |

The `reference` pubkey is included as a read-only key on the
`transferChecked` instruction so it appears in the transaction's
account list. An indexer watching the merchant's ATA sees the
reference attached to the inbound transfer and resolves it to a
ZettaPay invoice in one query.

### Example

```
solana:7vY3W7BLkcRJsX1mFCQbBPMy4U5tEZxbf18mPDHfvK7c?amount=29.00&spl-token=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&reference=8x7yA1mTpqEYbF7QvCk9oCk5w9wkrLwQbk8GDhWqkqGr&label=Acme%20Coffee&message=Order%20%234421
```

This is what a Solana Pay scanner sends to the merchant's wallet; the
wallet derives the merchant's USDC ATA from the recipient and the
mint, attaches the reference, and signs the transfer.

## 3. QR rendering

The reference SVG QR generator uses the following defaults; integrators
SHOULD match unless they have a strong reason to deviate.

| Option | Default | Rationale |
| --- | --- | --- |
| `size` | 256 px | Comfortably scannable on a phone from arm's length. |
| `margin` | 1 module | Cosmetic; the underlying lib defaults to 4. |
| `errorCorrectionLevel` | `M` (~15%) | Sweet spot for matte print. Use `H` (~30%) when overlaying a centred brand mark. |
| `color.dark` | `#0a1612` (Forest) | Veridian V2 brand palette. |
| `color.light` | `#f5e6c8` (Parchment) | Veridian V2 brand palette. |

Reference: [`../packages/sdk/src/solana-pay.ts`](../packages/sdk/src/solana-pay.ts)
(`generateInvoiceQrSvg`, `generateInvoiceQrDataUrl`).

## 4. Choosing between the two schemes

| Scenario | Recommended scheme |
| --- | --- |
| Generic wallet (Phantom, Solflare, Backpack, Glow, …) | `solana:` |
| ZettaPay-native widget / embed.js | `zettapay:` |
| Deep-link button on a checkout page | Both, with `solana:` as fallback |
| AI agent settlement (x402) | Neither — agents use the x402 header directly. See [`06-proof-formats.md`](./06-proof-formats.md). |

Wallets are free to advertise support for `zettapay:` via their
`acceptedSchemes` array; in its absence, fall back to `solana:`.
