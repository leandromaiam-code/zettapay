# ZettaPay — CLAUDE.md

Constitution of this repository for any agent or developer working in it. The
canonical Layer 0 lives in the Fabric workspace `zettapay`; this file mirrors it.

## What the product is

Non-custodial crypto payments. A merchant gives ZettaPay **public** material
only (BIP-84 xpub for Bitcoin; xpub or fixed receive address for Base). ZettaPay
derives a receive address per invoice, watches the chain, and delivers an
HMAC-signed webhook when the payment confirms. Funds settle directly in the
merchant's wallet.

- **Assets:** BTC, and USDC / USDT on Base. Nothing else.
- **Self-hosted:** `packages/listener` (`@zettapay/listener`) — open source, free, no limits.
- **Cloud:** `packages/cloud` (`@zettapay/cloud`) — the same listener core run
  multi-tenant over Supabase (`zettapay_*` tables), API under `/api/v1`, hosted checkout.
- **Customers:** developers and small online businesses that want to accept
  crypto without a custodian, and AI agents (via `@zettapay/mcp`, `llms.txt`, OpenAPI).

## Business model

- No per-transaction fee, ever. ZettaPay is not in the flow of funds.
- Self-hosted is free forever.
- Cloud is a flat monthly subscription by invoice volume (`packages/cloud/src/plans.ts`):
  the plan caps how many invoices a merchant may create per calendar month.
  The subscription may be paid by card or in crypto through ZettaPay itself.

## Hard Rules (never violate; enforced by `scripts/hr-scan.mjs`)

Source of truth: `fabric/seed/zettapay_hrs.json`. Explanation: `docs/HR-GATES.md`.

1. **HR-CUSTODY** — never hold, generate, store or sign with a private key that controls merchant or customer funds. No master seed, no sweep, no signing service.
2. **HR-WALLET-LESS** — never ask anyone to connect a wallet. No `wallet.connect()`, no wallet-adapter UI, no "Connect Wallet" button.
3. **HR-PII-MINIMAL** — onboarding collects email + shop name only. No identity documents. In public copy say "identity-free", never "KYC".
4. **HR-SECRETS-IN-GIT** (blocker) — no real keys or secrets in git; placeholders only.
5. **HR-PHONE-HOME** — the self-hosted listener never calls a ZettaPay-controlled domain. No hard-coded ZettaPay URLs in shipped code or public pages; use configuration or relative links.
6. **HR-OPTIONAL-DEPS** — storage backends are optional peer dependencies of the listener.
7. **HR-STORAGE-ADAPTER** — all listener persistence goes through `StorageAdapter`.

Run before every PR: `node scripts/hr-scan.mjs diff`.

## Engineering rules

- The listener core (`packages/listener/src`) is the product. Cloud is a thin
  shell around it — never fork the payment logic into `packages/cloud`.
- Additive changes only on the wire contract: the listener HTTP API, the Cloud
  `/api/v1` API and the webhook payload/signature stay backward compatible.
- Tenant isolation in Cloud: every authenticated request is scoped to the
  merchant resolved from the API key; another tenant's invoice is a plain 404.
- Database changes ship as idempotent, additive SQL in `packages/cloud/migrations/`.
  Never drop or truncate; the Supabase project is shared with other products.
- TypeScript strict. Tests for anything touching derivation, confirmation,
  auth, plan limits or webhook signing.
- English for code, docs and public copy.
- Do not claim what does not exist: no supported chain, SDK, integration,
  audit, partner or number may appear in docs or on the site unless it is real
  and verifiable in this repository or on a public registry.
- Do not mention AI tooling in commits, PRs or comments.

## Legacy — do not build on it

The repository still contains the pre-pivot Solana / x402 product. It is not
deployed, published or supported: `packages/api`, `packages/legacy-custodial`,
`programs/`, `idl/`, `Anchor.toml`, `packages/sdk-{go,php,python,rust}`,
`plugins/`, `legacy/`, and most of `docs/` (Mintlify sources).

## Where things run

- Website + docs: Vercel project `zettapay` (static `public/` + a few functions in `api/`).
- Cloud API + watcher fleet: long-running Node process (`node packages/cloud/dist/server.js`), not serverless.
- Packages: npm, published by tag via `.github/workflows/npm-publish.yml`.

## Commands

```bash
npm install
npm run build --workspace @zettapay/listener
npm test  --workspace @zettapay/listener
npm run build --workspace @zettapay/cloud && npm test --workspace @zettapay/cloud
node scripts/hr-scan.mjs diff
```
