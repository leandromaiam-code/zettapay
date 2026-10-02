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

## Accounts, plans and billing

Self-serve endpoints used by the dashboard at `/app` (all JSON):

- `POST /api/v1/signup` — public. `{ email, shop_name, btc_xpub?, base_xpub?, base_address?, webhook_url? }`.
  Returns the API key (and webhook secret) **once**. An extended *private* key is rejected and never stored.
  Throttled per client address.
- `GET  /api/v1/me` — account, plan, this month's usage, receive methods. Auth.
- `GET  /api/v1/invoices?limit=25` — the merchant's most recent invoices. Auth.
- `POST /api/v1/webhook` — set the webhook URL; issues a fresh signing secret. Auth.
- `GET  /api/v1/plans` — public plan catalogue (caps, prices, payment methods).
- `POST /api/v1/billing/checkout` — `{ plan, method: "crypto" | "stripe" }` → `{ checkout_url }`. Auth.
- `POST /api/v1/billing/stripe/webhook` — Stripe events (signature-verified).

A plan is a flat monthly price that only raises the monthly invoice cap
(`plans.ts`); there is no transaction fee. Paying in crypto issues an ordinary
ZettaPay invoice to the platform's own merchant account and activates the plan
for 30 days once it confirms. Paying by card opens a Stripe subscription.
A paid plan whose period has ended counts as `free` until it is renewed.

Webhook URLs must be `https` and resolve only to public addresses; this is
checked when the URL is saved and again before every delivery.

### Configuration

| Variable | Purpose |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Database (required) |
| `PORT`, `HOST` | Listen address |
| `CHECKOUT_BASE_URL` | Site origin for hosted checkout links and the dashboard |
| `PLAN_LIMITS`, `PLAN_PRICES` | JSON overrides for monthly caps and USD prices |
| `BILLING_MERCHANT_ID` | Merchant that receives crypto subscription payments (enables crypto billing) |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_STARTER`, `STRIPE_PRICE_PRO` | Card billing (optional) |
| `BASE_RPC_URLS` | Comma-separated Base RPC endpoints cross-checked by quorum in fixed-address mode |
| `BTC_WS_URL`, `BTC_REST_BASE`, `BASE_RPC_URL` | Chain data sources for the xpub watchers |

Migrations in `migrations/` are additive and idempotent; apply them in order.
