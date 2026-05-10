# Off-chain code review checklist (Z21.5)

This checklist is the gate a reviewer (human or autonomous squad) walks
before any change to the off-chain ZettaPay code (`packages/api`,
`packages/sdk`, `src/`, `plugins/`) is approved for merge into `main`.

The on-chain Anchor program has its own audit package — see
[`SCOPE.md`](SCOPE.md), [`THREAT_MODEL.md`](THREAT_MODEL.md), and
[`SECURITY_ASSUMPTIONS.md`](SECURITY_ASSUMPTIONS.md) for that engagement.
This document covers the rest of the codebase that the external audit
firm does *not* look at, but which moves real value (USDC) and handles
sensitive data (KYC, API keys, webhook secrets).

---

## How to use this checklist

1. The reviewer reads the diff against this list, top to bottom.
2. Every item is **YES**, **N/A**, or **BLOCK**. There is no "mostly".
3. A single **BLOCK** holds the merge. The author either fixes it or
   files a follow-up mission and removes the offending lines.
4. `audit/CRITICAL_PATHS.md` lists the paths with the strictest review
   bar. Touching those paths means walking this list *and* the
   path-specific list in that document.
5. `audit/OWASP_TOP_10.md` maps OWASP 2021 categories to the actual code
   that mitigates each. Use it as a back-stop when this checklist
   doesn't obviously cover a concern.

---

## A. Authentication & authorisation

| # | Check | Where this is enforced today |
| --- | --- | --- |
| A1 | New routes that mutate merchant or payment state require an API key (or stronger auth) | `packages/api/src/routes/*.ts` — most use `idempotency()` + key extraction in `middleware/rate-limit.ts:extractApiKey` |
| A2 | Agent-authenticated routes verify the `X-Agent-Identity` proof | `middleware/agent-identity.ts`, used by `pay`, `agent-to-agent`, `agent-spending-limits` |
| A3 | Treasury / admin routes require the `treasuryAuth` constant-time comparator | `middleware/treasury-auth.ts:38` (`timingSafeEqual`) |
| A4 | No new route trusts a body field for caller identity (`payerWallet`, `merchantId`) without server-side resolution from the auth context | `services/payments.ts:createPayment` resolves merchant by id + auth, never by client claim |
| A5 | API keys are never logged in plain | `lib/logger.ts` redactor + `middleware/request-logger.ts` |
| A6 | Webhook receivers verify HMAC over `req.rawBody`, not the parsed JSON | `lib/webhook-signature.ts:verifyWebhookSignature`; `lib/shopify.ts:verifyHmacQuery`; raw body captured in `app.ts:88` |

## B. Input validation

| # | Check | Where this is enforced today |
| --- | --- | --- |
| B1 | Every `req.body` field is validated with `zod` schemas or `lib/validate.ts` helpers — no raw casts to typed shapes | `lib/schemas.ts`, `lib/validate.ts:requireString` / `requirePositiveNumber` / `optionalRecord` |
| B2 | String fields have explicit `maxLength` (no unbounded strings reach storage) | `routes/pay.ts:34`, `routes/merchants.ts`, `routes/agent-identity.ts` |
| B3 | Numeric fields have explicit upper bounds, not just `> 0` | `routes/pay.ts:16` (`MAX_AMOUNT = 1_000_000`); `services/agent-spending-limits.ts` |
| B4 | Currency / mint inputs are normalised against an allow-list, never echoed back raw | `lib/currencies.ts:normalizeCurrency` |
| B5 | All `JSON.parse` of untrusted input is wrapped in try/catch and the error is downgraded to a 400, not a 500 | `middleware/idempotency.ts:67` parses cached body only after server-controlled write; external JSON parses go through `express.json()` |
| B6 | Path params (`:id`) used in DB queries pass through schema or regex validation before the query | `routes/merchants.ts`, `routes/kyc.ts`, `routes/treasury.ts` (UUID/handle validation) |

## C. SQL & persistence

| # | Check | Where this is enforced today |
| --- | --- | --- |
| C1 | All DB access uses `db.prepare(...)` parameterised statements — no string concatenation into SQL | every file in `packages/api/src/db/` uses `prepare(...)` + `?` placeholders |
| C2 | No `pragma foreign_keys = OFF`; foreign key constraints stay on | `db/index.ts:19` (`foreign_keys = ON`) |
| C3 | Migrations are forward-only and add columns with defaults; existing data never silently changes shape | `db/index.ts` ALTER TABLE blocks; squashed migrations checked in `supabase/migrations/` for prod |
| C4 | Sensitive decisions append a row to `audit_journal` — irreversible operations leave a trail | `db/audit_journal.ts:appendAudit` invoked from `routes/merchants.ts`, `routes/agent-spending-limits.ts`, `routes/registry.ts`, `coinflow/service.ts`, `services/treasury.ts` |
| C5 | Idempotency cache write happens *after* the response is computed but *before* the client receives it (no double-charge possible) | `middleware/idempotency.ts:75-88` patches `res.json` and writes inside the handler before the body flushes |

## D. Secrets & config

| # | Check | Where this is enforced today |
| --- | --- | --- |
| D1 | Every secret read from `process.env.*` is funnelled through `env.ts` with explicit type and presence checks | `packages/api/src/env.ts` |
| D2 | No secret value (API key, HMAC secret, RPC key) is interpolated into log messages, error bodies, or HTTP responses | `lib/logger.ts` redactor; `middleware/error-handler.ts` does not echo `details` for 500s |
| D3 | Service-role / admin keys are never read on the client SDK side | `packages/sdk/` only reads publishable keys; service role lives in `packages/api/src/env.ts` |
| D4 | `treasury.adminKey` shorter than 24 chars produces `config_error` and rejects every call | `app.ts:54-61` (comment); `routes/treasury.ts` enforces |
| D5 | `.env.example` is updated when a new secret is added; the real `.env` is never committed | `git ls-files | grep -E '^\.env$'` returns empty |

## E. Solana & money flow

| # | Check | Where this is enforced today |
| --- | --- | --- |
| E1 | The API never holds a mint authority, never custodies USDC; transfers go payer → merchant directly | `services/solana.ts:transferUsdc`, premise II.14 |
| E2 | Every signed transaction blob received from a payer (x402, agent-to-agent) is parsed, schema-checked, simulated, then submitted — in that order | `routes/pay.ts`, `services/payments.ts:createPayment`, `services/solana.ts:simulate` |
| E3 | Fee math is `BigInt`-safe — no `Number` arithmetic on lamports / USDC base units that would lose precision above 2^53 | `services/pricing.ts`, `services/treasury.ts:reserveDebit`, `services/agent-to-agent.ts:splitFee` |
| E4 | The merchant ATA is resolved server-side from the merchant binding, not from client-supplied `usdcTokenAccount` | `services/merchants.ts:findMerchant`, `services/payments.ts` |
| E5 | Per-agent spending limits (Z20.3) are checked *before* the SPL transfer is signed/simulated, not after | `services/agent-spending-limits.ts:checkAndDecrement`, called inside `createPayment` |
| E6 | Treasury reserve writes go through `services/treasury.ts` which holds the 5% TPV invariant — no direct DB writes from routes | `services/treasury.ts` is the only writer to `treasury_reserves` |

## F. Webhooks & outbound

| # | Check | Where this is enforced today |
| --- | --- | --- |
| F1 | Every outbound webhook signs with HMAC-SHA256 using a per-merchant secret | `services/webhook_dispatcher.ts`, `lib/webhook-signature.ts:signWebhook` |
| F2 | Outbound webhooks retry with exponential backoff (3x) and persist success/failure | `services/webhook_worker.ts`, `lib/webhook-queue.ts`, premise III.9 |
| F3 | Webhook URLs are validated as `https://` only — `http://` is rejected at registration | `services/merchants.ts` URL validator; premise IV.15 |
| F4 | Inbound webhooks (Sumsub, Coinflow, Shopify) verify signatures **over `req.rawBody`** and return 401 fast on mismatch | `app.ts:88` captures `rawBody`; `services/kyc/sumsub.ts:verifySignature`; `coinflow/service.ts`; `lib/shopify.ts` |
| F5 | Webhook dispatcher logs include the merchant id and event id, never the secret | `services/webhook_dispatcher.ts` |

## G. Rate limiting & abuse

| # | Check | Where this is enforced today |
| --- | --- | --- |
| G1 | Public mutating endpoints have rate limiting wired (per API key, falling back to IP) | `middleware/rate-limit.ts:apiKeyResolver`, `lib/rate-limit-redis.ts` |
| G2 | Rate-limit errors return `429` with `Retry-After` and structured JSON, not generic 500 | `middleware/rate-limit.ts:113`, `lib/errors.ts:RateLimitError` |
| G3 | Payment endpoints have a velocity check (per merchant, per agent) on top of rate-limit, to catch slow-burn abuse rate-limit can't see | `services/velocity.ts`, called from `services/payments.ts` |
| G4 | When the rate-limit Redis is unreachable, requests fail-open with a `rate_limit_store_failure` warn log — never silently fail-closed and lock everyone out | `middleware/rate-limit.ts:140-147` |

## H. HTTP hygiene

| # | Check | Where this is enforced today |
| --- | --- | --- |
| H1 | `x-powered-by` is disabled | `app.ts:80` |
| H2 | Default security headers (CSP, X-Frame, X-Content-Type, Referrer, Permissions, COOP, CORP, optional HSTS) are applied as the first middleware | `middleware/security-headers.ts`, wired in `app.ts` |
| H3 | `express.json()` body limit is bounded (256 KiB today) — payloads that approach the limit are rejected, not parsed and logged | `app.ts:87` |
| H4 | Errors do not leak stack traces or DB error messages to clients; only structured `{ code, message }` | `middleware/error-handler.ts:77-83` returns generic body for 500s |
| H5 | The `notFoundHandler` is the *last* middleware registered (so routes added after it would never match) | `app.ts:166-170` |
| H6 | Trust proxy is set explicitly so `req.ip` and HSTS are correct behind Vercel / a CDN | `app.ts:81` (`trust proxy = true`) |

## I. Logging & observability

| # | Check | Where this is enforced today |
| --- | --- | --- |
| I1 | Every request gets a correlation id (X-Request-ID, propagated to logs) | `middleware/request-logger.ts` |
| I2 | Logs are structured JSON via pino; no `console.log` in production paths | `lib/logger.ts`, `middleware/error.ts:22` only logs to console when `NODE_ENV !== "test"` |
| I3 | OpenTelemetry traces are emitted around DB and Solana RPC calls | `lib/tracer.ts`, `lib/tracing.ts` |
| I4 | No PII (email, full name, KYC document number) is logged at INFO; only at DEBUG behind a feature flag | `services/kyc/sumsub.ts`, `services/kyc/service.ts` redact before log |
| I5 | A `/healthz` returns 503 during graceful shutdown so a load balancer drains the instance cleanly | `app.ts:104-112`, `lib/shutdown.ts` |

## J. Tests

| # | Check | Where this is enforced today |
| --- | --- | --- |
| J1 | Every new route has at least a happy-path + auth-failure + validation-failure test | `packages/api/test/*.route.test.ts` pattern |
| J2 | Money-moving paths (`createPayment`, `agentToAgentPay`, treasury debit/credit) have test coverage that asserts both success and rollback on Solana failure | `pay.route.test.ts`, `agent-to-agent.test.ts`, `treasury.test.ts` |
| J3 | Webhook signature verification has positive + negative tests (good HMAC, wrong HMAC, missing header) | `webhook-signature.test.ts`, `shopify.hmac.test.ts` |
| J4 | Idempotency cache tests cover replay, body-mismatch (409), and key-format rejection | `idempotency.test.ts` |
| J5 | New `packages/api/src/**` files are added to `tsconfig.build.json` `include[]` and `dist/` is verified post-build | `packages/api/tsconfig.build.json`; recurring failure mode documented in mission memory |

## K. Build & deploy gates

| # | Check | Where this is enforced today |
| --- | --- | --- |
| K1 | `npm run build` is green from a clean `node_modules` | CI on every PR |
| K2 | `npm run typecheck` is green with `strict: true` (no `@ts-nocheck` in new code; premise VIII.28) | `tsconfig.json`, `tsconfig.build.json` |
| K3 | Tests pass — at minimum, the new test added with the change | `npm run test` in `packages/api` |
| K4 | The PR title and commit messages do not name Claude / Anthropic / external models (premise: code is proprietary Veridian) | reviewer eyeball |
| K5 | The PR title is in `<area>: <imperative>` form and ≤ 70 chars | reviewer eyeball |

---

## Reviewer sign-off block

Reviewers paste this at the end of the PR review:

```
Code review checklist (audit/CODE_REVIEW_CHECKLIST.md)
A — auth/authz: ☐ pass / ☐ block: <id>
B — input validation: ☐ pass / ☐ block: <id>
C — SQL & persistence: ☐ pass / ☐ block: <id>
D — secrets: ☐ pass / ☐ block: <id>
E — Solana/money: ☐ pass / ☐ block: <id>
F — webhooks: ☐ pass / ☐ block: <id>
G — rate limits: ☐ pass / ☐ block: <id>
H — HTTP hygiene: ☐ pass / ☐ block: <id>
I — observability: ☐ pass / ☐ block: <id>
J — tests: ☐ pass / ☐ block: <id>
K — build/deploy: ☐ pass / ☐ block: <id>
Critical paths touched (audit/CRITICAL_PATHS.md): <list or "none">
OWASP categories relevant (audit/OWASP_TOP_10.md): <list or "none">
```

A reviewer who marks all rows `pass` and identifies no critical paths is
the only state in which auto-merge is allowed for sensitive code.
