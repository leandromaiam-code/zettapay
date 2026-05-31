# Sentinel: Z74 retry 1/3 (UUID 6ff8b8b7) — already shipped in #312

This mission is an AUTO-RETRY (UUID `6ff8b8b7`) of parent `0dcdb548-a71c-4477-8b30-384e483e8d84`.
The parent's full scope already shipped and merged.

## Already on main (commit 54595b2, PR #312, 2026-05-31)

USDC fixed-address mode + decimal nonce + 1h TTL — listener `v0.4.0`.

| Deliverable | Status on main |
|---|---|
| `src/evm-amount-nonce.ts` (allocateNonce / encodeAmount / matchAmount) | present |
| `src/fixed-address-watcher.ts` (eth_getLogs Transfer watcher, value-match, orphan) | present |
| `src/invoice-core.ts` fixed-address branch (MERCHANT_EVM_ADDRESS, +1h TTL) | present |
| `test/evm-amount-nonce.test.ts` | present |
| `test/fixed-address-watcher.test.ts` | present |
| `package.json` version `0.4.0` | present |
| BTC (v0.2.0) + USDC-xpub Base (v0.3.0) untouched | preserved |

## Why no new code

Re-implementing would duplicate merged work and risk regressing the BTC and
USDC-xpub production paths that Z74 was explicitly forbidden from touching.
The protected baseline files (derive-bip84.ts, listener.ts, webhook-dispatcher.ts,
derive-evm.ts, base-watcher.ts) remain unchanged on main.

No action required beyond closing this retry.
