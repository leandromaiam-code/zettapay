# OWASP Top 10 (2021) coverage — ZettaPay off-chain

This document maps each [OWASP Top 10 (2021)](https://owasp.org/Top10/)
category to the ZettaPay off-chain code that prevents it, the test that
exercises the prevention, and any residual risk we have explicitly
accepted.

The on-chain Anchor program is covered separately by the
[STRIDE-style threat model](THREAT_MODEL.md). This document is the
off-chain counterpart: API, dashboard, plugins, SDK.

| Category | Status |
| --- | --- |
| A01 — Broken Access Control | **mitigated** (idempotency + agent identity + treasury auth) |
| A02 — Cryptographic Failures | **mitigated** (HMAC `timingSafeEqual`, no plaintext secrets at rest) |
| A03 — Injection | **mitigated** (parameterised SQL, zod validation) |
| A04 — Insecure Design | **mitigated** (no custody, immutable on-chain receipts, idempotency keys) |
| A05 — Security Misconfiguration | **mitigated** (security headers, no `x-powered-by`, hardened JSON limits) |
| A06 — Vulnerable Components | **monitored** (Dependabot + `npm audit` in CI; bug bounty Z21.4) |
| A07 — Identification & Authentication Failures | **mitigated** (constant-time API key check, Phantom signatures for reveal) |
| A08 — Software & Data Integrity Failures | **mitigated** (signed webhooks, signed transaction blobs, audit journal) |
| A09 — Logging & Monitoring Failures | **mitigated** (pino structured logs, OTel traces, `/healthz` drain) |
| A10 — Server-Side Request Forgery (SSRF) | **mitigated** (no user-supplied URLs are fetched server-side except validated webhook targets) |

---

## A01 — Broken Access Control

**Threat.** A caller invokes an endpoint they shouldn't (mutates another
merchant's data, debits another agent's balance, hits an admin route
without the admin key).

**Mitigations**

- **API-key resolution & rate limiting** — `packages/api/src/middleware/rate-limit.ts:extractApiKey`. Every mutating route either requires an API key directly or calls `agentIdentityMiddleware`.
- **Per-merchant ownership.** `routes/merchants.ts` and `services/merchants.ts` resolve `merchantId` against the authenticated key. The body-supplied `merchantId` is *only* used as a query key, never as the trust boundary.
- **Agent identity proof.** `middleware/agent-identity.ts` + `lib/agent-identity.ts` verify a payer-side signature over a server-issued nonce before per-agent spending state is read or written.
- **Treasury admin auth.** `middleware/treasury-auth.ts` does a constant-time comparison against `treasury.adminKey`. Short keys (< 24 chars) are rejected at boot — see `app.ts:54-61`.
- **Idempotency cache binding.** `middleware/idempotency.ts` keys cache entries by `(scope, key)`; reusing a key cross-scope is impossible because every route declares its own `scope` string.

**Tests**

- `packages/api/test/treasury.test.ts` — admin auth pass/fail, short key rejection.
- `packages/api/test/agent-identity.test.ts` — proof verification.
- `packages/api/test/agent-spending-limits.test.ts` — limit decrement.
- `packages/api/test/idempotency.test.ts` — cross-scope isolation.

**Residual risk.** A merchant whose API key is compromised. Mitigated by
key rotation (Z23.4, see `CRITICAL_PATHS.md` P8) and by the audit
journal so a rotation event is forensically traceable.

---

## A02 — Cryptographic Failures

**Threat.** Secrets at rest in plain, secrets in logs, weak HMAC,
non-constant-time comparison, predictable random.

**Mitigations**

- **HMAC verification is constant-time.** `lib/webhook-signature.ts:77` uses `crypto.timingSafeEqual`. `middleware/treasury-auth.ts:38`, `lib/shopify.ts`, and `services/kyc/sumsub.ts` follow the same pattern.
- **API keys hashed at rest.** `services/merchants.ts` stores SHA-256 of the key, never plaintext. The plaintext is returned exactly once, in the registration / rotation response.
- **Secrets via `env.ts` only.** `packages/api/src/env.ts` is the single ingress for secret material. Routes never read `process.env.*` directly.
- **No secrets in logs.** `lib/logger.ts` redacts `apiKey`, `signature`, `secret`, and `authorization` keys before serialisation. The error handler returns `{ code, message }` only — stack and DB errors stay server-side.
- **Random keys via `crypto.randomBytes`.** `services/merchants.ts` uses `crypto.randomBytes(32).toString("base64url")`. No `Math.random()` is used for security material.

**Tests**

- `packages/api/test/webhook-signature.test.ts` — good HMAC, wrong HMAC, length-mismatch.
- `packages/api/test/shopify.hmac.test.ts` — query-param HMAC verification.
- `packages/api/test/merchants.test.ts` — plaintext key returned once, hashed at rest.

**Residual risk.** Secrets in environment variables on the runtime host
(Vercel). Mitigated operationally — see launch checklist (Z22.1).

---

## A03 — Injection

**Threat.** SQL injection, command injection, server-side template
injection, prototype pollution from request bodies.

**Mitigations**

- **Parameterised SQL everywhere.** Every file in `packages/api/src/db/` uses `db.prepare(...)` with `?` placeholders. There is no string-built SQL anywhere in the package — `grep -rn "db.exec.*\${" packages/api/src/db/` returns empty for user-controlled values.
- **Zod / `lib/validate.ts` schemas at every entry point.** No route accepts a raw `req.body` cast without a schema check. See `routes/pay.ts:33-47` for the canonical pattern.
- **Path params validated** before they reach a query — UUIDs, handles, and numeric ids all go through schema or regex validation.
- **No `child_process.exec` on user input.** The API doesn't shell out at all. CI workflows in `.github/workflows/` do not interpolate user-controlled data into `run:` blocks.
- **Prototype pollution.** `idempotency.ts:canonicalize` does not `Object.assign` user payloads onto cached records; cached responses are JSON-serialised and parsed, so prototype is reset.

**Tests**

- `packages/api/test/idempotency.test.ts` — body canonicalisation.
- `packages/api/test/merchants.route.test.ts` — input validation rejects malformed bodies.
- `packages/api/test/pay.route.test.ts` — `MAX_AMOUNT` enforcement, invalid currency rejection.

---

## A04 — Insecure Design

**Threat.** A category-level flaw that no amount of bolt-on hardening
fixes — e.g. holding USDC custody, mutable on-chain receipts,
client-supplied destinations.

**Design choices that make this category small**

- **Zero custody.** ZettaPay's API never holds USDC. Transfers go payer
  → merchant directly, mediated by SPL Token. Constitution premise II.14.
- **Immutable on-chain receipts.** The Anchor program has no `update_*`
  or `close_*` instruction. Past payments cannot be silently rewritten.
  See [`THREAT_MODEL.md#T2`](THREAT_MODEL.md).
- **Idempotency keys mandatory** on the money-moving paths
  (`/pay`, `/agents/pay`, `/treasury/*`, `/merchants/register`,
  `/subscriptions`). No accidental double-charge surface.
- **Server-resolved destinations.** A client can request a payment to
  `merchantId` but cannot specify the USDC ATA — the binding determines
  it. Removes the "wrong ATA" footgun at the API layer.
- **Audit journal append-only.** `db/audit_journal.ts:appendAudit` is
  the only writer. Every sensitive decision (limit override, treasury
  debit, key rotation, KYC status flip) lands a row; no `UPDATE` or
  `DELETE` exists in the table's API.

---

## A05 — Security Misconfiguration

**Threat.** Default headers leak framework, framing allowed, verbose
error pages, unbounded body parsers, missing TLS, default admin keys.

**Mitigations** — all wired in `packages/api/src/app.ts`:

- `app.disable("x-powered-by")` removes the `Express` fingerprint.
- `securityHeaders()` middleware (`middleware/security-headers.ts`)
  sets the baseline:
  - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`
  - `X-Content-Type-Options: nosniff`
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: no-referrer`
  - `Permissions-Policy: geolocation=(), microphone=(), camera=(), payment=(), usb=(), interest-cohort=()`
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Resource-Policy: same-origin`
  - `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` (production only)
- `express.json({ limit: "256kb" })` caps body size; payloads beyond it
  are rejected before any handler runs.
- The error handler (`middleware/error-handler.ts`) returns
  `{ code, message, details }` only — no stack trace, no DB error text
  reaches a 500 response body.
- `notFoundHandler` is registered last so undocumented routes return a
  consistent JSON 404 instead of an Express HTML default.
- `treasury.adminKey < 24 chars` ⇒ `config_error` on every call,
  preventing mainnet from booting with a default / weak admin secret.

**Tests**

- `packages/api/test/security-headers.test.ts` — every header asserted.
- `packages/api/test/health.route.test.ts` — `/healthz` shape.

---

## A06 — Vulnerable & Outdated Components

**Threat.** Transitive dependency with a published CVE.

**Mitigations**

- **`npm audit` in CI.** A high-severity advisory fails the build.
- **Dependabot** is configured to open PRs on advisories.
- **Bug bounty (Z21.4).** A $50k public bounty covers vulnerabilities
  in any deployed component, including dependencies, until mainnet —
  see [`BUG_BOUNTY.md`](BUG_BOUNTY.md).
- **Pinned major versions** for `express`, `@solana/*`, `pino`,
  `bullmq`, `zod`. Minors and patches float.

**Residual risk.** Zero-day in a transitive dep that we cannot patch
faster than the audit window. Accepted; the launch checklist (Z22.x)
includes a hot-patch runbook.

---

## A07 — Identification & Authentication Failures

**Threat.** Predictable session ids, weak password resets, credential
stuffing, missing MFA on admin paths.

**Mitigations**

- **No passwords.** Merchant access is API-key + Phantom signature
  (wallet-native). No credential database, no reset flow, no MFA gap.
- **API keys are 256 bits of `crypto.randomBytes`.** No predictable
  format.
- **Phantom signature for sensitive reveal.** `POST /merchants/:id/api-key/reveal` requires the merchant to sign a server-issued nonce with their wallet — the same wallet that owns the on-chain binding. See `CRITICAL_PATHS.md` P8.
- **Constant-time API key comparison.** Hashes compared with
  `timingSafeEqual` to prevent timing oracles.
- **Agent identity proofs are nonce-bound.** `lib/agent-identity.ts` rejects re-played proofs against a different nonce.

**Tests**

- `packages/api/test/agent-identity.test.ts`
- `packages/api/test/merchants.route.test.ts` — bad key, missing key, expired key paths.

---

## A08 — Software & Data Integrity Failures

**Threat.** Unsigned updates, untrusted deserialisation, CI tampering,
webhook replay.

**Mitigations**

- **Webhook payloads HMAC-signed.** Inbound (`Sumsub`, `Coinflow`,
  `Shopify`) verified via `lib/webhook-signature.ts:verifyWebhookSignature`. Outbound signed via `signWebhook`.
- **Webhook replay protection.** `db/webhook_events.ts` deduplicates
  by `(provider, event_id)`.
- **Transaction blobs** (x402, agent-to-agent) are JSON-schema-validated
  *and* parsed by `@solana/web3.js` *and* simulated before signing —
  three independent integrity checks.
- **Audit journal append-only.** `db/audit_journal.ts` exposes
  `appendAudit` and read helpers; no `update`/`delete`.
- **CI integrity.** GitHub Actions workflows are pinned to commit
  hashes for third-party actions — see `.github/workflows/*.yml`.

---

## A09 — Logging & Monitoring Failures

**Threat.** A breach happens and we cannot tell from the logs.

**Mitigations**

- **Structured JSON via pino.** `lib/logger.ts`. Every log line has
  `level`, `time`, `msg`, and request `correlationId`.
- **Correlation ids.** `middleware/request-logger.ts` accepts an
  inbound `X-Request-ID` and generates one when absent. Propagated to
  downstream services and webhook bodies.
- **OpenTelemetry traces.** `lib/tracer.ts` + `lib/tracing.ts` cover DB
  and Solana RPC spans. Outbound HTTP spans via auto-instrumentation.
- **Sensitive events logged.** `rate_limit_exceeded`, `validation_error`,
  `webhook_unauthorized`, `treasury_admin_denied`, `agent_proof_invalid`
  all emit a structured warn / error. These are the queries an SOC
  would alert on.
- **`/healthz` drains during shutdown** — `app.ts:104-112` returns 503
  when `shutdown.isShuttingDown()`. Load balancers see the drain and
  stop routing.

**Residual risk.** A self-hosted deployer who pipes logs to `/dev/null`.
Documented in the README; out of our control.

---

## A10 — Server-Side Request Forgery

**Threat.** A user-supplied URL fetched by the server, allowing access
to internal metadata services or private network targets.

**Mitigations**

- **The API does not fetch arbitrary user-supplied URLs.** The only
  outbound HTTP destinations are:
  - Solana RPC (configured via `env.ts`, not user input)
  - Coinflow API (configured via `env.ts`)
  - Sumsub API (configured via `env.ts`)
  - Merchant webhook URLs — validated as `https://` at registration
    (premise IV.15) and never followed via redirects without the same
    origin check.
- **No URL preview, no link unfurl, no thumbnail fetch** in the API.
- **Webhook target URL** is rejected if it resolves to private CIDR
  ranges (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16`, `169.254.0.0/16`). Enforced in
  `services/merchants.ts` URL validator.

**Tests**

- `packages/api/test/merchants.test.ts` — webhook URL validation
  rejects non-HTTPS, malformed URLs, and private CIDR addresses.

---

## How to update this document

When a mission adds a new public-facing surface (new route, new inbound
webhook, new admin tool), update the relevant OWASP category with:

1. The mitigation in the new code (file + brief description).
2. The test that proves the mitigation works.
3. Any residual risk that was explicitly accepted, with reasoning.

This document is the single off-chain answer to "what about OWASP X?"
during external review.
