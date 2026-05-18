# @zettapay/listener

Self-hosted, **non-custodial** payment listener for the ZettaPay protocol.

## What it is

A small daemon a merchant runs on their own infrastructure to:

- watch on-chain activity for invoices generated from their `xpub` (BIP-84 BTC, BIP-44 EVM),
- dispatch HMAC-signed webhooks to the merchant's own backend when payments confirm,
- persist invoice and webhook state locally through a swappable `StorageAdapter` (JSON / SQLite / Supabase / Postgres).

## What it is not

- **Not custodial.** The listener never holds, derives, or signs with a private key. It only watches addresses derived from the merchant's `xpub`. See `HR-CUSTODY`.
- **Not wallet-coupled.** No `wallet.connect`, no Phantom/MetaMask UI, no browser-side signing. See `HR-WALLET-LESS`.
- **No phone-home.** The listener MUST NOT contact `zettapay.vercel.app`, `zettapay.dev`, `zettapay.com`, or `api.zettapay.*`. Outbound traffic is limited to `mempool.space` (and any merchant-configured chain RPC), the merchant's configured `MERCHANT_WEBHOOK_URL`, and the `STORAGE` adapter URL when the merchant chooses Supabase or Postgres. See `HR-PHONE-HOME`.

## Status — Z55

This release lands the **architectural foundation only**:

- `StorageAdapter` interface
- Type definitions (`Merchant`, `Invoice`, `WebhookEvent`, ...)
- A contract test suite (`test/storage-contract.ts`) future adapters must satisfy
- Package skeleton with **all storage backends declared as optional peer dependencies** so the default JSON mode boots with zero extra installs

No concrete adapter, CLI, watcher, or webhook-dispatcher business logic is implemented in this release. Those land in Z56–Z62.

## Design doc

See [`docs/architecture/self-hosted-listener-design.md`](../../docs/architecture/self-hosted-listener-design.md) for the canonical interface, JSON storage layout, dependency graph, CLI surface, phone-home prohibition, migration story, and conformance map.

## Optional peer dependencies

| `STORAGE=` | required peer dep             | install command                        |
|------------|-------------------------------|----------------------------------------|
| `json`     | (none — default)              | —                                      |
| `sqlite`   | `better-sqlite3`              | `npm install better-sqlite3`           |
| `supabase` | `@supabase/supabase-js`       | `npm install @supabase/supabase-js`    |
| `postgres` | `pg`                          | `npm install pg`                       |

A missing optional peer throws `MissingStorageDependencyError` with the exact install hint.

## License

MIT.
