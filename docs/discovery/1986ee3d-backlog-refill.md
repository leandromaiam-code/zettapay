# Auto-discovery — backlog refill (mission UUID prefix `1986ee3d`)

**Workspace:** zettapay (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Generated:** 2026-05-17
**Pass:** fifth refill after `fba46358` (#231), `69cdcbce` (#242), `4f79ec06` (#244),
`03cf9a17` (#245).

## Goal

Identify exactly five next-priority implementation gaps for the execution
backlog. Each pick must be:

- Single objective (one feature, one outcome)
- Single file (or one source/test pair if a verifier needs a peer test)
- Additive (no edits to existing files)
- **Outside** the chronic-broken `packages/api` compile lane
- Wallet-less hard rule respected (no `wallet.connect`, no wallet-adapter UI)
- CI-mergeable (build green out of the box)

## Survey of prior four refills

Prior passes drained the following surfaces (see `docs/discovery/{prior-uuid}-backlog-refill.{md,sql}`):

| Pass | Theme |
|------|-------|
| `fba46358` (#231) | Single-objective dev miscellany — SDK errors.ts tests, LOG_PRETTY docs, Immunefi link, etc. |
| `69cdcbce` (#242) | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff |
| `4f79ec06` (#244) | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| `03cf9a17` (#245) | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust CI, sdk-python CI |

## Gaps still open after that survey

Reading the repo top-down, the next layer of unaddressed surfaces is the
**polyglot SDK parity** layer + **repo hygiene** layer:

1. The TypeScript, Python, and Rust SDKs all expose a webhook signature
   verifier (`verifyWebhook` / `parse_webhook` / `Webhook::verify`). The Go
   and PHP SDKs do not. Premissa 9 (Stripe-grade webhooks) is satisfied
   server-side and in three SDKs but breaks language parity for the other
   two — exactly the kind of gap Premissa 23 (SDK-first) blocks adoption on.
2. The Python and Rust SDKs now have per-SDK CI workflows (`.github/workflows/sdk-{python,rust}.yml`,
   landed in pass `03cf9a17`). The Go SDK has had `.github/workflows/sdk-go.yml`
   since #51. The PHP SDK ships `phpunit.xml.dist` and a real `tests/`
   directory but **nothing in CI runs them**. Per-SDK CI parity is the same
   Premissa 23 + Premissa 29 argument.
3. `.github/` has zero supply-chain hygiene. No `dependabot.yml`, no
   `renovate.json`. With six published-or-publishable packages (TS SDK, TS
   embed, TS widget, Rust SDK, Python SDK, Go SDK, PHP SDK) plus the
   Vercel serverless surface, transitive-dep risk is real. Premissa 19
   (pre-mainnet $50k bug-bounty) and Premissa 22 (security headers) both
   point at supply-chain discipline.
4. `packages/embed/scripts/build.mjs` prints the gzipped IIFE size at every
   build (currently target ~5KB per the script's own banner) but **does not
   fail** when the budget is exceeded. Premissa 17 (bundle <200KB gzip
   site-wide) is much looser than the embed's own ~5KB target — and the
   embed is the only artifact small enough to be a real regression risk if
   we silently add 2KB per quarter. CI gate is the right place.
5. `.well-known/security.txt` (mission queued in pass `03cf9a17`) references
   `Acknowledgments: .../audit/HALL_OF_FAME.md`, which does not exist. This
   is a known dangling reference, but it is downstream of `security.txt`
   itself — and `security.txt` has not landed yet, so the dangling-reference
   mission is correctly **not** in this pass. Listed here as a known
   follow-up for the next refill.

## Picks

| # | Name | File(s) | Premise(s) | Rationale |
|---|------|---------|------------|-----------|
| 1 | sdk-go: webhook signature verifier | `packages/sdk-go/webhook.go` + `packages/sdk-go/webhook_test.go` | 9, 23 | Parity with TS / Python / Rust webhook verifiers; standard-library `crypto/hmac` + `crypto/sha256`; no third-party deps (matches Go SDK's own README claim of zero third-party deps). |
| 2 | sdk-php: webhook signature verifier | `packages/sdk-php/src/Webhook.php` + `packages/sdk-php/tests/WebhookTest.php` | 9, 23 | Parity with TS / Python / Rust webhook verifiers; uses PHP's `hash_hmac` + `hash_equals` (constant-time compare); zero external deps. |
| 3 | ci(sdk-php): phpunit workflow | `.github/workflows/sdk-php.yml` | 23, 29 | Per-SDK CI parity. PHP SDK has `phpunit.xml.dist` + `tests/` since #51 but no GitHub-Actions gate. Mirrors `sdk-go.yml` shape. |
| 4 | chore(deps): dependabot config | `.github/dependabot.yml` | 19, 22 | Supply-chain hygiene across npm / cargo / pip / composer / gomod / github-actions. Weekly cadence, grouped minor+patch. |
| 5 | ci(embed): gzip size budget gate | `.github/workflows/embed-size.yml` | 17 | Currently the embed build prints size but does not fail when over budget. Workflow builds + asserts `dist/embed.js` gzipped < 8 KB (current ~5 KB plus 60% headroom). |

## What each pick deliberately avoids

- **Pick 1 & 2 (Go + PHP webhook):** Do NOT add HTTP-framework adapters in
  this PR (no `gin`-specific middleware for Go, no PSR-15 middleware for
  PHP). Verifier surface only: pure `(payload, signature, secret) -> bool`.
  Frameworks come in a separate mission.
- **Pick 3 (sdk-php CI):** Do NOT add publish-to-Packagist. Test-gate only.
- **Pick 4 (dependabot):** Do NOT enable auto-merge for security updates in
  the dependabot config itself — that's a separate repo-admin mission.
- **Pick 5 (embed size gate):** Do NOT introduce a new bundler (esbuild
  stays). Do NOT split into multiple gates per artifact — single
  IIFE-gzip check is enough.

## SQL companion

See `docs/discovery/1986ee3d-backlog-refill.sql` — single
`BEGIN; … COMMIT;` transaction so partial application is impossible.

Per worker memory (`feedback_supabase_mcp_unavailable.md`), the Supabase
MCP is not granted to mission workers. The orchestrator (or a human
operator with the service-role key) applies the SQL on merge.

## Brand & wallet-less compliance

- No mention of Claude / Anthropic anywhere in companion docs, mission
  descriptions, or commit messages.
- Co-author tag: `Veridian Fabric <noreply@veridian.ai>`.
- Wallet-less hard rule: all five picks are wallet-neutral (webhook
  verifiers are HTTP-only; CI and dependabot are infra; size gate is a
  build assertion). Zero `wallet.connect` / `window.solana` / wallet-adapter
  surface area touched.
