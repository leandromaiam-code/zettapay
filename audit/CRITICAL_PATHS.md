# Critical paths — off-chain code

This document names the off-chain code paths whose failure would lose
USDC, leak KYC data, or break the protocol's safety invariants. Every
mission that touches one of these paths walks
[`CODE_REVIEW_CHECKLIST.md`](CODE_REVIEW_CHECKLIST.md) **plus** the
path-specific rules below.

The on-chain program is documented separately in [`SCOPE.md`](SCOPE.md)
and [`THREAT_MODEL.md`](THREAT_MODEL.md). This document covers the
off-chain surface only.

---

## Path P1 — `POST /pay` (USDC settlement)

**Files**

- `packages/api/src/routes/pay.ts`
- `packages/api/src/services/payments.ts` — `createPayment`
- `packages/api/src/services/solana.ts` — `transferUsdc`, `simulate`
- `packages/api/src/services/velocity.ts`
- `packages/api/src/services/agent-spending-limits.ts`
- `packages/api/src/middleware/idempotency.ts`
- `packages/api/src/middleware/agent-identity.ts`

**What this path does.** Resolves a merchant binding, validates the
caller (API key + optional agent identity proof), enforces velocity and
per-agent spending limits, builds + simulates + submits the SPL transfer,
records the payment row, fires the webhook, and (if auto-settle is
enabled) hands the payment to Coinflow.

**Invariants the path must keep**

1. **No double-charge.** The same `Idempotency-Key` + same body returns
   the cached response with `idempotent-replayed: true`. A different body
   for the same key returns `409`.
2. **No silent over-spend.** The agent identity's daily and per-request
   caps are checked **before** the SPL transfer is signed.
3. **No phantom successes.** If the SPL transfer simulation fails or
   submission errors, the payment row is either never written or written
   with `status: "failed"` — never `completed`.
4. **No client-supplied destination.** The merchant's USDC ATA is read
   from the binding by `merchantId`, never from a request field.
5. **Server-side currency normalisation.** `currency` flows through
   `normalizeCurrency` before reaching `createPayment`.

**Path-specific review rules**

- Any change to `createPayment` that adds a step between the spending-
  limit check and the SPL transfer must explicitly justify it not opening
  a TOCTOU window.
- Any change that touches `BigInt` arithmetic on lamports / USDC base
  units must keep `BigInt` end-to-end — no `Number()` casts.
- New fields persisted to `payments` need an `audit_journal` entry if
  they record a sensitive decision (e.g. why a fee was waived).

**Tests that must stay green**

- `packages/api/test/pay.route.test.ts`
- `packages/api/test/idempotency.test.ts`
- `packages/api/test/velocity.test.ts`
- `packages/api/test/agent-spending-limits.test.ts`

---

## Path P2 — `POST /merchants/register` (binding creation)

**Files**

- `packages/api/src/routes/merchants.ts`
- `packages/api/src/services/merchants.ts`
- `packages/api/src/db/merchants.ts`

**What this path does.** Validates the requested handle and owner
wallet, anchors the binding on-chain via the Anchor program, persists
the off-chain merchant row, generates the API key, and returns it
exactly once.

**Invariants**

1. **API key returned once, hashed at rest.** The plaintext key is in
   the response body and never persisted; the DB stores only the hash.
2. **Webhook URL is `https://`-only.** `http://` is rejected at
   registration with a `400`.
3. **Origin allow-list defaults closed.** `allowed_origins` defaults to
   `[]`, not `*`.
4. **Idempotent.** The endpoint is wrapped in `idempotency()` so a
   retried registration returns the original response, not a duplicate
   binding.
5. **Audit row.** `appendAudit("merchant.register", …)` is written
   inside the same transaction as the merchant insert.

**Path-specific review rules**

- Any change to API key generation must keep the scheme:
  `crypto.randomBytes(32).toString("base64url")`, hashed with SHA-256
  before storage.
- Adding a new field to `merchants` requires a corresponding migration
  *and* an update to `findMerchant` and `serializeMerchant` so the new
  field doesn't accidentally appear in webhook payloads.

**Tests**

- `packages/api/test/merchants.route.test.ts`
- `packages/api/test/merchants.test.ts`

---

## Path P3 — Inbound webhooks (Sumsub, Coinflow, Shopify, x402)

**Files**

- `packages/api/src/routes/webhooks.ts`
- `packages/api/src/routes/shopify.ts`
- `packages/api/src/services/kyc/sumsub.ts`
- `packages/api/src/coinflow/service.ts` (when `coinflow` is wired)
- `packages/api/src/lib/webhook-signature.ts`
- `packages/api/src/lib/shopify.ts`
- `packages/api/src/app.ts:88` (`rawBody` capture)

**Invariants**

1. **HMAC verified over the original bytes.** Every inbound handler
   compares against `req.rawBody`, not the parsed JSON.
2. **Constant-time comparison.** All HMAC checks use
   `crypto.timingSafeEqual`, never `===`.
3. **Reject before parse.** A failed signature returns `401` before any
   business logic runs and is logged with a `webhook_unauthorized` event.
4. **Replay protection.** Webhook events are de-duplicated by
   `(provider, event_id)` in `webhook_events`.
5. **Body size cap.** The global `express.json({ limit: "256kb" })` is
   the upper bound; no inbound handler raises it.

**Path-specific review rules**

- Adding a new inbound webhook source means: (a) capturing the secret
  through `env.ts`, (b) verifying signature in the route's first
  handler, (c) writing a `webhook_unauthorized` test, (d) writing a
  `webhook_replay` test.
- Never log the secret or the signature header value at INFO. Hash
  before logging if a fingerprint is needed.

**Tests**

- `packages/api/test/webhook-signature.test.ts`
- `packages/api/test/webhooks.route.test.ts`
- `packages/api/test/shopify.hmac.test.ts`
- `packages/api/test/kyc.sumsub.test.ts`

---

## Path P4 — Outbound webhooks (merchant → ZettaPay event delivery)

**Files**

- `packages/api/src/services/webhook_dispatcher.ts`
- `packages/api/src/services/webhook_worker.ts`
- `packages/api/src/lib/webhook-queue.ts`
- `packages/api/src/lib/webhook-signature.ts` — `signWebhook`
- `packages/api/src/db/webhook_events.ts`

**Invariants**

1. **Stripe-grade retry.** 3× exponential retry with persistence; final
   failure flips status to `failed` and emits a metric, never silently
   drops.
2. **Signed payload.** Every outbound POST carries
   `X-ZettaPay-Signature: sha256=<hex>` computed over the raw body.
3. **No PII in payload beyond what the merchant already has.** Webhook
   payloads carry only ids and statuses; full KYC documents stay
   server-side.
4. **TLS required.** Outbound HTTP target validation is in
   `services/merchants.ts` at registration time, not in the dispatcher.

---

## Path P5 — KYC (`packages/api/src/services/kyc/*`)

**Files**

- `packages/api/src/routes/kyc.ts`
- `packages/api/src/services/kyc/provider.ts` — interface
- `packages/api/src/services/kyc/sumsub.ts` — Sumsub adapter
- `packages/api/src/services/kyc/service.ts` — orchestration
- `packages/api/src/db/kyc.ts`

**Invariants**

1. **PII at rest is hashed or encrypted.** Document numbers, full
   names, and DOB never appear in plain text in the DB; only opaque
   provider-side application IDs are stored locally.
2. **No KYC PII in webhook bodies.** The outbound webhook carries
   `kyc_status` only — never the document.
3. **No KYC PII in logs.** `services/kyc/*` redact before calling the
   logger; reviewers confirm by reading every `logger.info(...)` in the
   diff.
4. **Provider not wired ⇒ 503 `kyc_disabled`.** Without a `kyc`
   `KycProviderClient`, every route under `/merchants/:id/kyc/*`
   returns 503 instead of half-running.
5. **Sumsub HMAC** verified on every inbound webhook.

---

## Path P6 — Treasury / insurance reserve (5% TPV pool, Z22.3)

**Files**

- `packages/api/src/routes/treasury.ts`
- `packages/api/src/services/treasury.ts`
- `packages/api/src/db/treasury_reserves.ts`
- `packages/api/src/middleware/treasury-auth.ts`

**Invariants**

1. **Admin auth on every mutating call.** `treasury-auth.ts` uses
   `timingSafeEqual` against `treasury.adminKey`.
2. **Admin key length floor.** A `treasury.adminKey` shorter than 24
   chars is rejected at boot — every call returns `config_error`. This
   protects mainnet from accidental open admin endpoints.
3. **Idempotent debits/credits.** `POST /treasury/reserve/debits` and
   `POST /treasury/reserve/credits` both require an `Idempotency-Key`.
4. **Audit row per write.** Every reserve mutation appends to
   `audit_journal` inside the same transaction.
5. **Invariant: reserve_balance ≥ 0** asserted on every debit; a debit
   that would underflow returns `409 reserve_insufficient`, never
   throws.

---

## Path P7 — Agent identity & spending limits (Z20.3, Z20.4)

**Files**

- `packages/api/src/lib/agent-identity.ts` — proof verification
- `packages/api/src/middleware/agent-identity.ts`
- `packages/api/src/routes/agent-identity.ts`
- `packages/api/src/routes/agent-spending-limits.ts`
- `packages/api/src/services/agent-identity.ts`
- `packages/api/src/services/agent-spending-limits.ts`
- `packages/api/src/services/agent-to-agent.ts`

**Invariants**

1. **Proof signature must verify against the registered pubkey** before
   any read or write of agent state.
2. **`max_per_request` and `daily_cap`** are checked + decremented
   atomically inside `services/payments.ts:createPayment`. There is no
   path where a payment goes through after a partial limit decrement.
3. **Freeze button is one-way per session.** A frozen agent cannot pay
   until the merchant explicitly thaws.
4. **Agent-to-agent payments** go through the same `createPayment` so
   they inherit identical idempotency, velocity, and audit guarantees —
   they do not have a parallel money-moving code path.

---

## Path P8 — API key issuance / rotation / reveal

**Files**

- `packages/api/src/routes/merchants.ts` (rotate, reveal endpoints)
- `packages/api/src/services/merchants.ts`
- `src/app/dashboard/...` (front-end reveal flow)

**Invariants**

1. **Reveal requires Phantom signature** of a server-issued nonce —
   never just an authenticated session.
2. **Rotate invalidates the old key immediately**, persists an audit
   row, and notifies via webhook.
3. **No key value crosses the wire twice.** The plaintext is in the
   reveal/rotate response and nowhere else.
4. **Constant-time API-key comparison** on every request — handled by
   the API key middleware (compares hashes).

---

## How to extend this list

When a mission introduces a new code path that:

- moves USDC,
- handles KYC PII,
- mutates treasury state,
- gates agent spending,
- accepts a webhook from a third party,

…add a `Pn` block in this document covering: files, invariants,
path-specific review rules, and tests. The
[`CODE_REVIEW_CHECKLIST.md`](CODE_REVIEW_CHECKLIST.md) bar is the floor;
this document is what raises the bar where the floor isn't enough.
