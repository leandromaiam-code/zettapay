# @zettapay/cloud

Managed, **non-custodial** ZettaPay. This is the exact `@zettapay/listener` core you
would self-host, run instead as a multi-tenant service behind a Supabase-backed
`StorageAdapter`. Same BIP-84 derivation, same watchers, same retry curve, same
HMAC webhook signature — a hosted merchant and a self-hosted merchant settle
payments byte-identically on the wire. No lock-in: point the SDK at your own
listener whenever you like and nothing changes.

## The trust delta

The cloud sees **invoice metadata** — amounts, statuses, public receive
addresses, your webhook URL + HMAC secret. That is all.

It never sees, holds, or can move **funds or keys**:

- Receive addresses are derived from your **public xpub** (BTC: BIP-84,
  Base: BIP-44) or a **public fixed receive address** + per-invoice nonce.
- No private key, seed phrase, or signing material is ever transmitted or
  stored. The database columns simply do not exist.
- Payments go **directly to your wallet**. ZettaPay is never in the flow of funds.

Onboarding is identity-free: an email, a shop name, and a public xpub.

## How it maps to the self-hosted listener

| Self-hosted | Cloud |
| --- | --- |
| `JsonFileStorage` / `SqliteStorage` | `SupabaseStorageAdapter` (multi-tenant) |
| One merchant per process | Every tenant reconciled by one watcher fleet |
| `WebhookDispatcher` (one URL + secret) | `CloudWebhookDispatcher` (per-tenant URL + secret) |
| `http-server` POST /invoice | `CloudApiServer` POST /api/v1/invoice |

The watchers (`BtcListener`, `BaseWatcher`) are imported **unmodified**: they only
call `listPendingInvoices()`, which the adapter scopes across every tenant, so a
single fleet reconciles all merchants at once.

## HTTP API

Mirrors the self-hosted listener's HTTP shape so the SDK, MCP server and OpenAPI
spec work against the cloud base URL with zero changes.

- `GET  /api/v1/health` — liveness, public.
- `POST /api/v1/invoice` — create an invoice (`chain: "btc" | "base"`). Auth.
- `GET  /api/v1/invoice/:id` — fetch one of *your* invoices. Auth + tenant isolation.

Authenticate with an API key in the `X-ZettaPay-Api-Key` header:

```
X-ZettaPay-Api-Key: zp_live_<48 hex chars>
```

A key is shown **once** at seed time; only its SHA-256 hash + a short display
prefix are persisted.

## Provisioning a merchant

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
SEED_EMAIL=you@shop.com SEED_SHOP="My Shop" \
SEED_BTC_XPUB=zpub... \
npm run seed --workspace @zettapay/cloud
```

The raw API key is printed once. Store it immediately — it cannot be recovered.

## Running the service

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
npm run start --workspace @zettapay/cloud
```

Starts the API server plus the watcher fleet (BTC listener + Base watcher +
per-tenant webhook dispatcher). Optional: `PORT`, `HOST`, `BTC_WS_URL`,
`BTC_REST_BASE`, `BASE_RPC_URL`.

## Environment

| Var | Purpose |
| --- | --- |
| `SUPABASE_URL` | Shared Supabase project URL (required) |
| `SUPABASE_SERVICE_ROLE_KEY` | Service-role key for PostgREST (required) |
| `PORT` / `HOST` | API bind (default `8080` / `0.0.0.0`) |
| `BTC_WS_URL` / `BTC_REST_BASE` | mempool.space overrides |
| `BASE_RPC_URL` | Base RPC endpoint |
