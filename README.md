# ZettaPay

[![@zettapay/listener](https://img.shields.io/npm/v/%40zettapay%2Flistener?label=%40zettapay%2Flistener)](https://www.npmjs.com/package/@zettapay/listener)
[![@zettapay/sdk](https://img.shields.io/npm/v/%40zettapay%2Fsdk?label=%40zettapay%2Fsdk)](https://www.npmjs.com/package/@zettapay/sdk)
[![license: MIT](https://img.shields.io/badge/license-MIT-f5e6c8.svg)](./LICENSE)

**Non-custodial crypto payments that confirm themselves.** Accept Bitcoin and
USDC / USDT on Base straight into your own wallet. ZettaPay watches the chain,
confirms the payment and sends your backend a signed webhook. It never holds
your keys and never touches your funds.

- **Non-custodial.** You give ZettaPay a *public* key only: a BIP-84 xpub for
  Bitcoin, and for Base either an xpub or a fixed receive address. Every invoice
  gets an address derived from it; the money settles on-chain, directly to you.
- **Wallet-less and identity-free.** No wallet connection, no identity checks.
  Onboarding is an email, a shop name and a public key.
- **No transaction fee.** ZettaPay is not in the flow of funds, so there is no
  percentage to take. The payer only pays the network fee of the chain.
- **Agent-ready.** An MCP server (`@zettapay/mcp`), `llms.txt` and an OpenAPI
  spec let AI agents create and check invoices.

## Two ways to run it

| | Self-hosted | Cloud |
|---|---|---|
| What | [`@zettapay/listener`](./packages/listener#readme) on your own machine | The same listener core, run by us as a multi-tenant service ([`@zettapay/cloud`](./packages/cloud#readme)) |
| Cost | Free, open source (MIT), no limits | Flat monthly subscription by invoice volume, with a free tier |
| Who sees what | Nothing leaves your box | We see invoice metadata and public addresses — never keys or funds |
| Status | Published on npm | Early access — self-serve: create an account at `/app` on the site |

Both speak the same HTTP API and emit the same webhook, so you can move between
them by changing one base URL.

### Self-hosted quickstart

```bash
npm install @zettapay/listener
npx zettapay-listener init     # asks for your xpub / address and webhook URL
npx zettapay-listener start    # watcher + webhook dispatcher + HTTP API
```

Full guide, environment variables, Docker and the threat model:
[`packages/listener/README.md`](./packages/listener/README.md).

### Cloud

```bash
curl -X POST "$ZETTAPAY_URL/api/v1/invoice" \
  -H "X-ZettaPay-Api-Key: $ZETTAPAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"chain":"base","amount_usd":29}'
```

The response carries the receive address, a QR URI and a hosted `checkout_url`.
Details: [`packages/cloud/README.md`](./packages/cloud/README.md) and
[`docs/architecture/cloud-tier.md`](./docs/architecture/cloud-tier.md).

## Supported assets

| Chain | Asset | Address mode |
|---|---|---|
| Bitcoin | BTC | One address per invoice, derived from your xpub (BIP-84) |
| Base | USDC, USDT | xpub (one address per invoice) **or** a fixed address + per-invoice amount nonce |

Nothing else is supported today.

## Packages

| Package | npm | Purpose |
|---|---|---|
| `packages/listener` | `@zettapay/listener` | Self-hosted watcher, HTTP API, webhook dispatcher, CLI |
| `packages/cloud` | — (not published yet) | Multi-tenant service over Supabase: API keys, plans, hosted checkout |
| `packages/sdk` | `@zettapay/sdk` | TypeScript client + webhook signature verification (`@zettapay/sdk/server`); still carries some Solana-era helpers |
| `packages/receiver` | `@zettapay/receiver` | Local webhook receiver for testing an integration |
| `packages/widget` | `@zettapay/widget` | **Legacy.** Solana-era pay button; not compatible with the current listener |
| `packages/embed` | `@zettapay/embed` | **Legacy.** Solana-era embed; not compatible with the current listener |
| `packages/mcp` | `@zettapay/mcp` | MCP server exposing `create_invoice`, `get_invoice_status` and `list_supported_assets` to AI agents |

To put a payment on a page today, create an invoice through the API and send the
payer to the hosted `checkout_url` (Cloud), or render the returned `qr_uri` and
address yourself and poll the invoice status.

Packages are published from this monorepo: pushing a `v<version>` tag runs
[`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml), which
publishes every package whose `package.json` version matches the tag.

## Hard rules

Four invariants are enforced by a scanner on every pull request
([`docs/HR-GATES.md`](./docs/HR-GATES.md)): no custody of keys or funds, no
wallet connection, minimal personal data, no secrets in git. Three more protect
the self-hosted listener (no phone-home, optional storage dependencies, all
persistence behind `StorageAdapter`).

```bash
node scripts/hr-scan.mjs diff     # what your branch adds vs origin/main
```

## Development

```bash
npm install
npm run build --workspace @zettapay/listener
npm test  --workspace @zettapay/listener
npm test  --workspace @zettapay/cloud
```

CI ([`test.yml`](./.github/workflows/test.yml)) builds and tests the listener
stack; `hr-scan.yml` runs the hard-rule scanner on the diff.

## Legacy code in this repository

ZettaPay started as a Solana / x402 payment API and pivoted in May 2026 to the
non-custodial model above. The earlier code is still in the tree and is **not**
part of the product: it is not deployed, not published and not supported.

- `packages/api`, `packages/legacy-custodial` — the original Express API
  (x402, on-ramp, subscriptions, fraud rules).
- `programs/`, `idl/`, `Anchor.toml` — a Solana program that was never deployed
  to mainnet.
- `packages/sdk-go`, `sdk-php`, `sdk-python`, `sdk-rust`, `plugins/` — clients
  and e-commerce plugins for that API; none were published to a registry.
- `legacy/` — the website pages and serverless functions of that era.
- `docs/` (Mintlify sources) — largely describes the old API; trust the package
  READMEs and `docs/architecture/cloud-tier.md` instead.

Do not build new work on any of it.

## License

MIT — see [LICENSE](./LICENSE).
