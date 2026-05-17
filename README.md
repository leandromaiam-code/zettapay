# ZettaPay

[![@zettapay/sdk](https://img.shields.io/npm/v/%40zettapay%2Fsdk?label=%40zettapay%2Fsdk&color=0a1612)](https://www.npmjs.com/package/@zettapay/sdk)
[![@zettapay/widget](https://img.shields.io/npm/v/%40zettapay%2Fwidget?label=%40zettapay%2Fwidget&color=d4a961)](https://www.npmjs.com/package/@zettapay/widget)
[![@zettapay/embed](https://img.shields.io/npm/v/%40zettapay%2Fembed?label=%40zettapay%2Fembed&color=f5e6c8)](https://www.npmjs.com/package/@zettapay/embed)
[![license: MIT](https://img.shields.io/badge/license-MIT-f5e6c8.svg)](./LICENSE)

Open-source universal payment protocol on Solana for humans and AI agents.

## Install

```bash
npm install @zettapay/sdk
# drop-in checkout button + modal + Phantom deeplink + hosted flow
npm install @zettapay/widget
# lean ~5 kB embed — QR + address + on-chain polling, zero runtime deps
npm install @zettapay/embed
```

All three packages are published from this monorepo. A push of a `v<version>`
git tag triggers [`.github/workflows/npm-publish.yml`](./.github/workflows/npm-publish.yml),
which builds and publishes `@zettapay/sdk`, `@zettapay/widget`, and
`@zettapay/embed` with npm provenance attestations.

## Live deployment

| Environment | URL |
| --- | --- |
| Production (Vercel) | https://zettapay.vercel.app |
| Custom domain | https://zettapay.fabric.4profitai.com |
| Documentation | https://docs.zettapay.io |

Quick checks:

```bash
curl https://zettapay.vercel.app/healthz
curl https://zettapay.vercel.app/simulate/test-merchant
```

## Tech Stack
- Node.js + Express + TypeScript (long-running server)
- Vercel Serverless Functions (`/api/*`) for the public preview
- @solana/web3.js + @solana/spl-token
- Solana devnet (USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)

## Setup
```bash
npm install
cp .env.example .env   # fill SOLANA_FEE_PAYER_SECRET
npm run dev
```

## Endpoints

### `POST /merchants/register`
Receives a Phantom wallet pubkey, creates the merchant's USDC ATA on
devnet (rent ~0.002 SOL paid by the protocol fee payer) and emits a
memo program transaction binding the merchant id to the wallet on-chain.

Request:
```json
{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<phantom-pubkey>" }
```

Response (201):
```json
{
  "merchant": { "id": "...", "walletAddress": "...", "ataAddress": "...", "status": "active" },
  "binding": {
    "ataAddress": "...",
    "ataCreated": true,
    "txSignature": "...",
    "memoPayload": "{\"ns\":\"zettapay:merchant_register:v1\",...}",
    "feePayer": "...",
    "cluster": "devnet"
  },
  "apiKey": "zp_live_..."
}
```

### `GET /simulate/:merchant`
Hackathon demo simulator. Returns a deterministic synthetic merchant plus
a fake airdrop and payment, with no on-chain side effects. Available on
Vercel as a serverless function and on the local Express server.

```bash
curl https://zettapay.vercel.app/simulate/test-merchant
```

## Features
- Merchant onboarding via Phantom wallet
- USDC P2P payments
- MoonPay onramp (card → USDC)
- x402 header support
- MCP endpoint for AI agents
- Native integration recipes for Anthropic Claude, OpenAI, and Hugging Face — see [docs/concepts/native-integrations](docs/concepts/native-integrations.mdx)

## Z45 master seed setup (HD wallet per-invoice infrastructure)

ZettaPay 2.0 derives every invoice receive address from a single offline-
generated BIP-39 master mnemonic — BTC under BIP-84 (`m/84'/0'/0'/0/{i}`,
bech32 P2WPKH) and USDC/EVM under BIP-44 (`m/44'/60'/0'/0/{i}`, EIP-55
checksum). The same mnemonic + path imported into Sparrow / Electrum /
Metamask recovers the funds independent of ZettaPay infrastructure.

**Mandatory one-time setup (before any mainnet invoice):**

1. **Generate the mnemonic OFFLINE.** Use a hardware wallet (Trezor /
   Coldcard / Keystone) or an air-gapped machine running
   [`bip39`](https://iancoleman.io/bip39/) from a verified release. 24 words
   give 256 bits of entropy — do not use 12-word seeds in production.
2. **Paper-backup the mnemonic, twice.** Store one copy in the operator's
   safe and one in a geographically separate vault (bank deposit box,
   secondary office safe). Do not photograph. Do not type it into a
   networked machine after step 3. Loss of all paper copies = loss of every
   merchant's funds.
3. **Verify recovery before funding.** Restore the mnemonic on a second
   air-gapped device and confirm `m/84'/0'/0'/0/0` matches the address
   produced on the original device. Never trust an unverified backup.
4. **Upload the mnemonic to Supabase Vault** as the secret named
   `ZETTAPAY_MASTER_SEED`. The Vault uses `pgsodium` for at-rest encryption;
   the service-role key decrypts on read. Once uploaded, wipe the mnemonic
   from any clipboard / shell history (`history -c`, then close the terminal).

```sql
-- Run once, in the Supabase SQL editor (NOT via Claude / MCP / shell history).
select vault.create_secret(
  $secret$<paste your 24-word mnemonic here>$secret$,
  'ZETTAPAY_MASTER_SEED',
  'ZettaPay HD wallet master seed — paper backup: vault A + vault B'
);
```

5. **Apply the migration.** `supabase/migrations/20260517000000_zettapay_invoices.sql`
   creates `public.zettapay_invoices`, the `zettapay_invoice_index_counters`
   table, and the `zettapay_allocate_invoice_index(text)` function that
   guarantees atomic index allocation under concurrent invoice creation.
6. **Set the admin gate.** Generate `ZETTAPAY_ADMIN_API_KEY` (≥24 chars)
   and store it in Vercel project envs. `/admin/invoices` returns 503 until
   the key is set.

**Recovery drill (run quarterly):**

```bash
# 1. Restore mnemonic on an air-gapped machine.
# 2. Derive m/84'/0'/0'/0/0 and m/44'/60'/0'/0/0 in your tool of choice.
# 3. Confirm those addresses match `select receive_address from
#    public.zettapay_invoices where derivation_index = 0 order by chain;`
```

If addresses diverge, the Vault secret has rotated or the seed copy is wrong
— halt all new invoices and reconcile before further use.

### `POST /admin/invoices`

Allocates the next derivation index for the requested chain, derives the
receive address from the master seed, and persists an invoice row.

Request:
```http
POST /admin/invoices
Authorization: Bearer <ZETTAPAY_ADMIN_API_KEY>
Content-Type: application/json

{
  "merchant_id": "acme",
  "amount_usd": 12.50,
  "chain": "base",
  "ttl_seconds": 1800
}
```

For `chain=btc` the body must include `amount_native` (a string with at
most 8 decimal places, in BTC). For USDC chains the server fills
`amount_native = amount_usd` rounded down to 6 decimals.

Response (201):
```json
{
  "invoice_id": "8c2…",
  "receive_address": "0xAbC…",
  "derivation_path": "m/44'/60'/0'/0/42",
  "amount_native": "12.500000",
  "expires_at": "2026-05-17T20:30:00.000Z",
  "qr_uri": "ethereum:0x833589f…@8453/transfer?address=0xAbC…&uint256=12500000",
  "chain": "base",
  "required_confirmations": 5
}
```

The listener (Z46/Z47), sweep cron (Z48), checkout UI (Z49), and Solana →
BTC/USDC migration (Z50) build on top of this foundation.

## Protocol spec

The public wire-level specification — URI schemes, instruction
discriminators, PDA seeds, account layouts, error codes, and proof
formats — lives in [`protocol/`](./protocol/README.md). This is the
mirror of what will be published at
[`github.com/zettapay/protocol`](https://github.com/zettapay/protocol)
for SDK authors, wallet integrators, and indexers building against
ZettaPay.

## Vercel deployment

The project ships with a thin `/api/*` serverless layer that mirrors the
public-facing routes of the Express server. It is independent of the
SQLite-backed long-running runtime, so it runs cleanly on Vercel without
native modules or persistent storage.

```
api/
├── index.ts                # GET /api      → metadata
├── healthz.ts              # GET /healthz  → liveness
├── simulate/[merchant].ts  # GET /simulate/:merchant → demo simulator
└── _lib/                   # shared helpers (base58, …)
```

Routing:

- `vercel.json#rewrites` exposes `/healthz` and `/simulate/:merchant` at the
  root, matching the Express route shape.
- Every function uses 1 GB RAM and a 30 s `maxDuration` budget.
- The build command is a no-op — Vercel auto-detects the `api/**/*.ts` functions
  and compiles them with its bundled `@vercel/node` runtime.

Local emulation:

```bash
npx vercel dev
curl http://localhost:3000/healthz
curl http://localhost:3000/simulate/test-merchant
```

## OpenAPI spec & multi-language SDKs

Every deployment serves a machine-readable spec for codegen:

| Endpoint | Flavor |
| --- | --- |
| `GET /openapi.json` | OpenAPI 3.1 (source of truth) |
| `GET /openapi-3.0.json` | OpenAPI 3.0.3 (openapi-generator-friendly) |
| `GET /docs` | Swagger UI (Try-it-out enabled) |

Committed snapshots live in [`docs/api-reference/`](./docs/api-reference/) and
language clients can be regenerated on demand:

```bash
npm run openapi:export    # refresh both 3.1 and 3.0 snapshots
npm run sdk:generate      # python + go + rust + php via openapi-generator-cli
```

The TypeScript SDK in [`packages/sdk`](./packages/sdk) is hand-tuned and
canonical; the other packages (`sdk-python`, `sdk-go`, `sdk-rust`,
`sdk-php`) have generated stubs sitting alongside vendored hand-written
clients. See [`docs/sdk/multi-language.mdx`](./docs/sdk/multi-language.mdx)
for the full workflow.

## Documentation site

The public docs at [docs.zettapay.io](https://docs.zettapay.io) live in
[`docs/`](./docs) and are rendered by [Mintlify](https://mintlify.com).
Mintlify builds directly from the `main` branch — there is no Vercel
build for the docs site.

```bash
npm run docs:dev      # local preview at http://localhost:3000
npm run docs:check    # validate links and references
```

See [`docs/README.md`](./docs/README.md) for the full structure and
Algolia DocSearch configuration.

## Docker

Multi-stage `node:20-alpine` image. The runtime stage runs as non-root, exposes
port `3001` and ships a Node-based `HEALTHCHECK` against `/healthz`.

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:3001/healthz
```

SQLite state is persisted in the named volume `zettapay-data` (mounted at
`/app/data` inside the container).

## Community

The ZettaPay Discord is the primary support and discussion surface for
merchants, agent builders, and SDK users. The server layout — channels
(`#help`, `#showcase`, `#api`, `#announcements`, …), roles, rules, and the
companion welcome + role bot — lives in
[`community/discord/`](./community/discord/README.md).

## Security and audit

Per ZettaPay constitution rules 16, 18 and 19, mainnet launch is gated
on a third-party audit of the on-chain program (OtterSec or Halborn)
plus a public bug bounty.

The audit submission package lives in [`audit/`](./audit) and contains
the threat model, scope, security assumptions, self-disclosed known
issues, the parallel $50k bug bounty terms, and the engagement
logistics for the audit firm. The on-chain program itself is in
[`programs/zettapay/src/lib.rs`](./programs/zettapay/src/lib.rs).

Vulnerability disclosures: `security@zettapay.io`. Public bounty
program details: [`audit/BUG_BOUNTY.md`](./audit/BUG_BOUNTY.md).
