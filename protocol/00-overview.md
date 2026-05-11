# 00 · Overview

## What the protocol does

ZettaPay is a non-custodial payment receipt protocol on Solana. The
on-chain program owns three pieces of state:

1. A **Merchant** PDA — a permanent on-chain identity for a payee,
   keyed on the merchant's master signer.
2. A monotonically-indexed family of **Invoice** PDAs — one allocated
   per checkout, deterministic from the merchant + an integer index.
3. A `status` flag on each invoice (`Open` → `Swept`) the merchant can
   flip in batch once the underlying USDC transfer is observed.

USDC itself never enters the program. Payment flows through standard
SPL `transferChecked` instructions from the payer's ATA to the
merchant's ATA, and the merchant correlates settlement to the invoice
via either the invoice PDA (used as a Solana Pay `reference`) or a
matched `(merchant, amount, timestamp)` tuple.

## Why three instructions, not one

Splitting the protocol into `RegisterMerchant`, `CreateInvoice` and
`Sweep` produces three concrete properties:

- **Address predictability.** The invoice PDA is derivable off-chain
  *before* `CreateInvoice` lands. Wallets can render a QR and embed
  the PDA as a Solana Pay reference at quote time, not after a
  round-trip.
- **Receipt durability.** Settlement is observable two ways — by
  watching the merchant's USDC ATA, or by reading the invoice PDA
  status. Both must agree before a merchant accepts the order, which
  is what closes the "I sent to the right address but the merchant
  marked the invoice unpaid" failure mode.
- **Sweep batching.** Merchants accept many invoices per block but
  rarely care to mark them individually. `Sweep` accepts a batch of
  indices in one tx so the on-chain marker stays cheap to maintain.

## Premise alignment

The protocol enforces three premises at the program boundary; the rest
are off-chain SLAs handled by the API.

| Premise | Enforcement |
| --- | --- |
| **I.1** — Solana-only V1 | `RegisterMerchant` rejects a chain set missing `CHAIN_SOLANA = 0` (`SolanaChainRequired`) |
| **I.2** — USDC-only V1 | `CreateInvoice` rejects `currency != CURRENCY_USDC = 0` (`CurrencyUnsupported`) |
| **IV.14** — No custody | `Sweep` only flips status fields; USDC `transferChecked` is independent and merchant-bound |

The `chains` field on the merchant account is still recorded as a
declared set so Z11 multi-chain settlement can route to the same
merchant without forcing re-registration.

## Threat model summary

ZettaPay assumes the standard Solana adversary model — an attacker
can craft arbitrary transactions, propose look-alike accounts, and
replay observed signatures. The program defends through five layered
checks performed at every state-touching instruction:

1. **Owner check.** A foreign-owned account passed as a Merchant or
   Invoice yields `ProgramError::IllegalOwner` before any Borsh
   deserialize runs.
2. **Signer check.** Every authority-bearing account (master, payer)
   must have `is_signer = true` (`MissingRequiredSignature`).
3. **System program check.** The system program account passed for
   `create_account` is compared against `system_program::ID`
   (`IncorrectProgramId`), guarding against a CPI rerouted to a
   look-alike.
4. **PDA seed check.** Every Merchant and Invoice account is
   re-derived from its seeds before use. A mismatch returns the
   structured error (`MerchantPdaMismatch` / `InvoicePdaMismatch`)
   so off-chain decoders can distinguish the failure mode.
5. **Tag check.** The first byte of each owned account's data is its
   account type (`MERCHANT_TAG = 1`, `INVOICE_TAG = 2`). An attacker
   who tries to feed an `Invoice` where a `Merchant` is expected hits
   `NotMerchantAccount` before Borsh ever runs.

The detailed list of error variants and their `u32` discriminator
values is in [`05-error-codes.md`](./05-error-codes.md).

## What the protocol does **not** do

- It does not hold USDC. Sweep does not touch token balances.
- It does not enforce settlement freshness. A merchant who sweeps an
  invoice before observing the USDC transfer is breaking their own
  invariant; the chain cannot recover the funds.
- It does not version invoices. The status state machine is one-way
  (`Open` → `Swept`); refunds are a separate off-chain flow that emits
  a new USDC transfer in the opposite direction.
- It does not gate or KYC payers. Compliance is handled exclusively
  at the fiat onramp (MoonPay) per Premise V.17.

## Compatibility with the legacy Z9 program

A first-generation Anchor program (Z9 era, `programs/zettapay/`) shipped
with a different schema — instruction names `register_merchant` /
`record_payment`, PDA seeds keyed on a string handle, 8-byte Anchor
discriminators — and a frozen IDL at [`../idl/zettapay.json`](../idl/zettapay.json).

The current native program at `programs/zettapay-core/` (Z25.2 modular
split) is the canonical target for new integrations and is what this
spec normatively describes. The Z9 program's IDL is retained for
ecosystem readers that have not yet migrated; do not generate new
clients against it.

When the two programs co-exist on the same cluster, they will share
the same declared Program ID at compile time. The on-chain key
deployed at `solana program deploy` time is independent of the
`declare_id!` constant — operators choose one and only one at deploy.
