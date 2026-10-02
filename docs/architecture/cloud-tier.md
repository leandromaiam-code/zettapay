# ZettaPay Cloud — Architecture (non-custodial managed tier)

> **Status:** Design v1 · 2026-06-01
> **Principle:** ZettaPay Cloud runs the *watching, confirming and notifying* infrastructure
> as a managed service. **Funds always settle on-chain directly to the merchant's own wallet.
> ZettaPay never holds keys, never holds funds, never takes custody.** The only secret ZettaPay
> ever stores about money is *nothing* — it stores the merchant's **public** xpub / address.

---

## 0. The invariant (what makes this honest)

The self-hosted listener is already non-custodial *by construction*: `createInvoice()` derives
the receive address **only from `merchant.xpub`** (a public key), and funds go straight to that
address on-chain. ZettaPay never sees a private key.

**ZettaPay Cloud keeps that exact invariant.** Cloud is not a new payment engine — it is the
**same `@zettapay/listener` core**, run by us as a multi-tenant service, with a **Supabase
`StorageAdapter`** instead of SQLite/JSON. The Supabase adapter lives in a **separate cloud
package** (`@zettapay/cloud`) that *depends on* the listener core — the self-hosted listener
stays 100% dependency-free (no Supabase) so the open-source path never needs an external vendor.

> If a feature would require us to hold a private key or move a merchant's funds, it does not ship.
> That line is non-negotiable and is what the whole architecture is built to preserve.

| Capability | Self-hosted | Cloud | ZettaPay *can* do? |
|---|---|---|---|
| Derive receive address from merchant xpub | ✅ | ✅ | yes (public key only) |
| See invoice metadata (amount, status) | merchant only | merchant + ZettaPay | yes |
| Move / withdraw merchant funds | ❌ | ❌ | **never** (no private key exists) |
| Hold funds in transit | ❌ | ❌ | **never** (funds go direct to wallet) |
| Sign transactions | ❌ | ❌ | **never** |

The trust delta vs self-hosted is **only** that ZettaPay sees invoice metadata + public addresses.
It is *informational* exposure, never *custodial* exposure.

---

## 1. What we reuse vs what we leave behind

**Reuse (the clean non-custodial core — `packages/listener/src/`):**
- `invoice-core.ts` — multi-merchant already (`storage.getMerchant`, derives from xpub)
- `derive-bip84.ts` (BTC) · `derive-evm.ts` (Base) — public-key derivation
- `base-watcher.ts` · `fixed-address-watcher.ts` · `evm-amount-nonce.ts` — confirmation
- `rpc-quorum.ts` — 2-of-N RPC cross-check
- `webhook-dispatcher.ts` — HMAC-SHA256 signed webhooks
- `rate-limit.ts` · `types.ts` · `StorageAdapter` interface

**Leave behind (pre-pivot legacy — do NOT base cloud on these):**
- `packages/api` (`@zettapay/api`) — x402 facilitator + coinflow (custodial rails)
- `packages/legacy-custodial`
- any Solana / Ethereum-L1 path

The cloud service is a **thin multi-tenant shell around the listener core**, nothing more.

---

## 2. Surfaces

```
zettapay.4profitai.com
├── /                     landing (live)
├── /app                  merchant dashboard  (today: waitlist → becomes the SaaS)
│   ├── /app/login,/signup
│   ├── /app/onboarding   paste xpub / EVM address  (the only thing we ask for)
│   ├── /app/keys         API keys
│   ├── /app/webhooks     webhook URL + secret
│   └── /app/invoices     payment history (read-only, on-chain verifiable)
├── /checkout/:invoiceId  hosted checkout page (QR, address, expiry, live status)
└── /api/v1/*             multi-tenant REST API (mirror of listener HTTP API)
```

`/checkout` is the **same checkout UX** we already shipped for knexo
(`/opt/knexo-checkout/checkout.html`) — chain selector, QR, decimal-nonce, 1h expiry — but
hosted by ZettaPay and parameterized per merchant.

---

## 3. Components

### 3.1 Cloud API (`/api/v1`) — multi-tenant listener
- Lives in a **new package `@zettapay/cloud`** (NOT the legacy `packages/api`).
- Wraps the **listener core** with:
  - **Auth middleware**: API key → `merchant_id` (per-tenant scoping on every call)
  - **Supabase `StorageAdapter`** (new) implementing the existing interface, backed by the
    **shared Supabase project `heqrvpoebkmliwnslxpi`** (same project as Fabric / Vortex / Pulse).
    All tables namespaced `zettapay_*` to avoid collision in the shared project.
- Endpoints mirror the self-hosted listener so the SDK/MCP/OpenAPI are identical:
  - `POST /api/v1/invoice` `{amount_usd|amount_sats, chain, asset?}`
  - `GET  /api/v1/invoice/:id`
  - `GET  /api/v1/health`
- **Same OpenAPI spec, same `@zettapay/sdk`, same `@zettapay/mcp`** — only the base URL changes.
  A merchant can move self-hosted ↔ cloud by swapping `LISTENER_URL`. Zero lock-in.

### 3.2 Watcher fleet (shared, non-custodial)
- One pool of watchers for **all** tenants:
  - **BTC**: one address per invoice, derived from each merchant's xpub (BIP-84).
  - **Base (USDC/USDT)**: xpub mode (1 addr/invoice) OR fixed-address + decimal-nonce.
- RPC quorum (2-of-N) for confirmation — reused as-is.
- Scales horizontally; watchers only ever read public chain data + public addresses.

### 3.3 Webhook dispatcher
- Reuses `webhook-dispatcher.ts`: HMAC-SHA256 over raw body, ms timestamp, replay protection,
  retry with backoff. Per-merchant secret stored encrypted at rest.

### 3.4 `/app` dashboard
- Next.js (App Router) — same stack as knexo-lab, deploys on the existing Vercel project.
- Auth: **Supabase Auth** (email + OAuth) — `auth.uid()` maps to a `zettapay_merchants` row.
  No crypto knowledge required from the user.
- Onboarding asks for **only the xpub or EVM address** — never a seed, never a private key.
  Inline validation (xpub/zpub format, EIP-55 checksum) + a derive-preview ("payments will
  arrive at addresses like 0x… / bc1…, all controlled by you").

### 3.5 `/checkout/:invoiceId`
- Hosted, mobile-first, dark/glass (matches the knexo checkout we already built).
- Live status via SSE/poll; QR + copy-address; expiry countdown; chain/asset selector.
- Optional merchant branding (logo, name) — metadata only.

---

## 4. Data model (Postgres) — stores only public / non-sensitive data

Shared Supabase project `heqrvpoebkmliwnslxpi`, all tables `zettapay_*`-prefixed, RLS on:

```
zettapay_merchants        id, auth_uid (→ Supabase Auth), email, created_at
zettapay_merchant_keys    id, merchant_id, api_key_hash, label, created_at, revoked_at
zettapay_merchant_chains  merchant_id, chain, xpub|fixed_address, evm_tokens  ← PUBLIC keys only
zettapay_webhooks         merchant_id, url, secret_enc (encrypted at rest)
zettapay_invoices         id, merchant_id, chain, asset, amount, address, nonce,
                          status, tx_hash, expires_at, created_at, paid_at
zettapay_webhook_events   id, invoice_id, payload, hmac, attempts, delivered_at
```

**No private keys. No seeds. No funds. No mnemonics.** A full DB compromise leaks invoice
history + public addresses + (encrypted) webhook secrets — it can **never** move a single satoshi.

> **Self-hosted vs cloud store (resolved):** the "no Supabase" rule governs the **self-hosted
> listener** (zero external dependency — keeps SQLite/JSON). The **cloud product** is a managed
> SaaS and uses the shared **Supabase project `heqrvpoebkmliwnslxpi`** (Fabric/Vortex/Pulse),
> tables namespaced `zettapay_*`. RLS scopes every row to its `auth.uid()`; the cloud API uses
> the service role for the watcher fleet.

---

## 5. Security & privacy
- **Non-custodial** (the invariant above) — the headline.
- **Per-invoice address** (xpub mode) → payments are unlinkable.
- **HMAC-signed webhooks** + replay protection (reused).
- **RPC quorum** 2-of-N → no single RPC can spoof a confirmation.
- **Tenant isolation**: every query scoped by `merchant_id`; API key → tenant.
- **Encryption at rest** for webhook secrets; TLS everywhere.
- **No telemetry, identity-free**: we don't profile payers; we only watch chain + notify.
- **Audit**: every payment independently verifiable on-chain by the merchant.

---

## 6. Billing (how cloud earns without touching funds)
Because cloud is non-custodial and protocol fee is 0%, ZettaPay **cannot** skim payments.
Revenue = **subscription for the managed infrastructure** (flat monthly tier), billed separately
(Stripe or ZettaPay itself). Tiers gate: # invoices/mo, # webhooks, branded checkout, SLA.
→ **Business decision, flagged in §8.**

---

## 7. Phased rollout

- **Phase A — Cloud API MVP (foundation)**
  Postgres `StorageAdapter` + auth middleware wrapping the listener core. `POST /api/v1/invoice`
  works multi-tenant. Watcher fleet runs for all tenants. *Definition of done:* a second merchant
  (besides knexo) can create + confirm a real invoice via API key.

- **Phase B — `/app` dashboard**
  Signup → xpub onboarding → API key → invoice history. Replaces the waitlist page.

- **Phase C — `/checkout/:invoiceId`**
  Hosted checkout pages (port the knexo checkout). Merchant gets a no-code payment link.

- **Phase D — Billing + branding + SLA**
  Subscription tiers, branded checkout, analytics.

Each phase is independently shippable and never weakens the non-custodial invariant.

---

## 8. Decisions
1. **Managed store** — ✅ **DECIDED**: shared Supabase project `heqrvpoebkmliwnslxpi`
   (Fabric/Vortex/Pulse), tables `zettapay_*`. Abstracted behind `StorageAdapter`.
2. **Auth for `/app`** — ✅ **DECIDED**: Supabase Auth.
3. **Billing rail** *(Phase D, open)*: Stripe vs ZettaPay-on-ZettaPay (dogfood) vs both.
   *Recommendation:* Stripe for fiat subscription now; dogfood later as a flex.
4. **Sales positioning of the trust delta** *(open)*: be explicit on the landing that cloud sees
   invoice metadata (but never funds). *Recommendation:* yes — honesty is the brand.

---

## 9. One-line summary
**ZettaPay Cloud = the exact `@zettapay/listener` you'd self-host, run by us as a multi-tenant
service with a Postgres store, an `/app` dashboard and a hosted `/checkout`. Same non-custodial
core. We only ever store your public xpub. Your funds never touch us.**
