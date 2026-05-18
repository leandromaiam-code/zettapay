# packages/legacy-custodial — QUARANTINE

**Status:** DEPRECATED. Do not import from any active code path.

This directory holds code that violated HR-CUSTODY — the non-custodial
invariant of ZettaPay. It is preserved for git archaeology only.

## What's here

| File | Why it was quarantined |
| --- | --- |
| `evm.ts` | `EvmService` loaded `EVM_PAYER_PRIVATE_KEY` and signed ERC-20 transfers on behalf of merchants via `viem`'s `createWalletClient` + `privateKeyToAccount`. |
| `evm_payments.ts` | Wrapper around `EvmService.transferToken` — same custodial sign flow. |
| `pay_evm.ts` | Express route that exposed `/pay/evm/:merchant` backed by the EVM payer key. |

## Replacement architecture (Z53)

ZettaPay no longer holds private keys for merchants. The new flow:

1. Merchant supplies their own **xpub** (BIP-84 `zpub` or BIP-44 `xpub`) at signup.
2. ZettaPay derives per-invoice child addresses from the xpub via `m/0/{index}`.
3. Customer pays from any wallet they choose.
4. ZettaPay's listener watches the mempool for inbound TXs and fires webhooks.

No private key, no seed, no `sign*` method ever runs against merchant funds.

## HR scan allowlist

`packages/legacy-custodial/` is allowlisted in `scripts/hr-scan.mjs` so the
quarantined patterns here don't trip the PR gate. Anything that re-introduces
the same patterns **outside** this directory will be blocked.
