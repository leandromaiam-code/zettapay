# Auto-discovery backlog refill — 2026-05-16 (UUID 4f79ec06)

**Mission:** Identify exactly 5 dev-execution gaps to refill the ZettaPay backlog.
**Workspace:** zettapay (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `4f79ec06`
**Branch:** `auto/4f79ec06--auto-discovery-identificar-pr-ximos-5-g`

---

## Selection method

Prior two backlog refills (PR #231 / `fba46358` — SDK webhook parity + bug-bounty + log env doc; PR #242 / `69cdcbce` — five Z33E site-launch fixes) drained the obvious surface-level queue. This pass scanned three under-covered surfaces — the **multi-language SDK public API**, the **root `/api/*` Vercel serverless lane** (the only compile lane currently green, per worker memory `project_build_broken.md`), and **`vercel.json` HTTP-level configuration** — for gaps that are both (a) shovel-ready (single file, no design call) and (b) untouched by any open or recently-merged PR.

Every pick was independently re-validated at mission-generation time:

| # | Re-check command | Result |
|---|---|---|
| 1 | `grep -E 'parse_webhook\|WebhookError' packages/sdk-python/zettapay/__init__.py` | 0 matches in `__all__`, 0 imports |
| 2 | `grep 'pub use webhook' packages/sdk-rust/src/lib.rs` | 0 matches (only `pub mod webhook;` at line 40) |
| 3 | `grep -E 'Access-Control-Allow' vercel.json` | 0 matches (only `Cache-Control` + `X-Powered-By` on `/api/(.*)`) |
| 4 | `grep -rln 'X-RateLimit' api/` | only `api/faucet.ts` — `api/pay.ts` and `api/payments.ts` ship none |
| 5 | `diff <(jq -r '.endpoints \| keys[]' <(node api/index.ts)) <(jq -r '.rewrites[].source' vercel.json)` (manual diff) | `api/index.ts` lists 14 endpoints; `vercel.json` exposes ~33 — gaps include `/status`, `/launch`, `/pricing`, `/docs`, `/faucet`, `/signup`, `/dashboard/:merchant`, `/checkout/:invoice_id` |

All five are **single-file**, **safe-lane** (no pick touches `packages/api/`, the chronically-broken compile lane), **wallet-less compliant** (none introduce wallet UX — the HARD rule from `CLAUDE.md` is intact), and **auto-merge eligible** under the existing Auto-Merge Squad rubric.

---

## Picks

| # | Mission | Target file | Effort | Layer 0 premissa |
|---|---|---|---|---|
| 1 | Python SDK — re-export `parse_webhook` + `WebhookError` at package level | `packages/sdk-python/zettapay/__init__.py` | XS | 23 (SDK-first multi-lang parity) |
| 2 | Rust SDK — re-export `webhook::*` at crate root | `packages/sdk-rust/src/lib.rs` | XS | 23 (SDK-first multi-lang parity) |
| 3 | `vercel.json` — add CORS headers to `/api/(.*)` so browser SDKs can call from any origin | `vercel.json` | S | 11, 23 (rate-limit + SDK-first) |
| 4 | `api/pay.ts` — emit `X-RateLimit-*` response headers (mirror `api/faucet.ts` pattern) | `api/pay.ts` | S | 11 (rate-limit by API key) |
| 5 | `api/index.ts` — sync endpoint discovery JSON with current `vercel.json` rewrites | `api/index.ts` | S | 24 (docs site — first-touch endpoint discoverability) |

---

## Why each is a valid gap (Layer 0 alignment)

- **#1 — Python SDK webhook export.** TypeScript SDK exports `parseWebhook` directly from the package root (`packages/sdk/src/index.ts`). Rust SDK has it under `zettapay::webhook::*`. Python users today must dig into `zettapay.webhook` and there is no entry in `__all__` — `from zettapay import *` silently omits the helper. The webhook verifier shipped two days ago in PR #235; the export wiring just wasn't part of that PR's scope. Premissa 23 says SDK parity is the moat.
- **#2 — Rust SDK webhook re-export.** Symmetric to #1. `lib.rs:40` already does `pub mod webhook;` but the crate root does not re-export the public symbols. Idiomatic Rust crates re-export their public API at the crate root (see `serde::*`, `tokio::*`). Two-line fix: `pub use webhook::{parse_webhook, ParsedWebhook, WebhookError, DEFAULT_TOLERANCE_SEC};`.
- **#3 — CORS headers on the API lane.** `vercel.json:147-160` sets only `Cache-Control: no-store` and `X-Powered-By: ZettaPay` on `/api/(.*)`. There is **no** `Access-Control-Allow-Origin`, `-Methods`, `-Headers`, or `Max-Age`. Result: any browser-side SDK consumer (the embed widget, the checkout page, a third-party merchant's storefront) hits a CORS preflight failure on every cross-origin POST. The fix is to add an explicit headers block — five lines. Premissa 23 (browser SDK is a first-class consumer) + 11 (we already publish a rate-limit story; CORS is the same tier of cross-cutting concern).
- **#4 — Rate-limit headers on `/api/pay`.** `api/faucet.ts` is the only endpoint that emits `X-RateLimit-Limit` / `X-RateLimit-Remaining` / `X-RateLimit-Reset`. `api/pay.ts` is the highest-value POST in the entire surface (every payment intent passes through it) and ships zero rate-limit signal back to the SDK. Stripe ships these on every endpoint; we already do it for `/api/faucet`, so the pattern is in-tree. This mission ports the pattern to `/api/pay` only (single file, tight scope); follow-up missions can extend to `payments.ts`, `merchants/register.ts`, `mcp.ts`, etc. Premissa 11 (rate limit per API key with response headers).
- **#5 — Endpoint discovery drift.** `api/index.ts` lists 14 endpoints; the actual public surface (`vercel.json` rewrites + filesystem) is roughly 33 routes including all the public site pages and several API endpoints (`/api/status`, `/api/status/feed.rss`, `/api/merchants/[merchant]/*`). For a developer landing on `GET /api`, the discovery JSON is wrong-by-omission — they see no `/status` feed, no `/signup`, no `/dashboard`, no `/checkout`. The fix is to expand the `endpoints` object to mirror `vercel.json` rewrites, grouped by category (api vs site). Premissa 24 (docs site as trust signal) — `GET /api` is the API equivalent of a docs landing page.

---

## Wallet-less hard rule

`grep -rn "wallet.connect|window.solana.connect|window.ethereum.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask"` against each of the 5 target files → **zero matches**. None of these missions add wallet code; none touch wallet adapter UI.

---

## Z-number & zombie sanity

Cross-referenced the last 50 PRs (`gh pr list --state all --limit 50`) and the worker-memory zombie log. None of these 5 picks overlap with:

- **Z31** SDK-language family — Python webhook (#235), Rust webhook (#236), and the SDK 2.0 skeleton (#126) are all merged but none touch `__init__.py` `__all__` or `lib.rs` re-exports.
- **Z32** wallet-less refactor (#177 / #178 / #143 / #187) — finished; no overlap with API surface or vercel.json headers.
- **Z33** site-launch chain (#237 rewrites, #239 vercelignore, #238 secret leak, #241 audit, #242 backlog refill, #243 hero copy) — all touched `public/*.html` or `docs/`; none touched `vercel.json` headers, `api/*.ts` rate-limit headers, or SDK package roots.
- **Backlog from PR #231 (`fba46358`)** — Python webhook helper (→ #235), Rust webhook helper (→ #236), SDK `errors.ts` test (→ #234), `LOG_PRETTY` env doc (→ #233 open), `BUG_BOUNTY` devnet ref (→ #232). These are the **builders** of the webhook helpers; this mission picks up the **wiring** that those PRs intentionally scoped out.
- **Backlog from PR #242 (`69cdcbce`)** — OG meta, broken footer link, robots/sitemap, pay.html lang, signup dashboard fallback. All HTML-only, no overlap.

No zombie risk — the `name` of every one of these 5 missions is unique against the existing missions table (verified by string match against last-50 PR titles).

---

## Build-lane safety

None of the 5 missions touch:

- `packages/api/` (chronic build break — `src/db/payments.ts`, `src/server.ts`, `src/services/payments.ts`). Worker memory `project_build_broken.md`: Vercel `/api/` functions are a separate compile lane — safe additive lane.
- `tsconfig.build.json` include-list (memory `feedback_tsconfig_build_allowlist.md`).
- `packages/sdk/src/*` runtime code (only Python and Rust SDK roots, which compile independently).

Targets are: 2 SDK package root files (Python + Rust), 1 `vercel.json` config-only edit, 2 Vercel serverless functions under the safe additive lane. `npm run build` will be unaffected on every PR these missions spawn — the gate stays in the same state as `main`.

---

## Rejected candidates (flagged for human triage, not auto-merge)

These came up during the scan but were deliberately excluded:

1. **Rename `USDC_MINT_ADDRESS` → `SOLANA_USDC_MINT` in `.env.example`.** `packages/api/src/config.ts:80` reads `process.env.SOLANA_USDC_MINT` but `.env.example:14` documents `USDC_MINT_ADDRESS`. This is a real bug, BUT fixing it cleanly requires either (a) editing `packages/api/src/config.ts` — which sits in the chronic-broken lane — or (b) renaming the var in `.env.example` and hoping no production deploy already depends on the documented name. Routing-decision territory — flagged for human triage.
2. **Document missing env vars in `.env.example` (HOST, SHUTDOWN_TIMEOUT_MS, GIT_SHA, LOG_LEVEL, REDIS_URL, …).** Similar to #1 — most are read by code in `packages/api/src/server.ts` and `packages/api/src/lib/`. Verifying which are still live vs. dead requires reading the chronic-broken lane. PR #233 (open, from prior backlog refill) already covers `LOG_PRETTY`; the rest should follow a single audit pass against the actual API source after the chronic break is repaired.
3. **CORS headers on `api/onramp/webhook.ts`.** Inbound MoonPay webhook. Adding CORS here is the wrong fix — webhook receivers should validate signatures, not whitelist origins. Out of scope.
4. **Idempotency-Key full implementation in `api/pay.ts`.** The handler validates the header length (line 92) but doesn't store the key for replay protection. Real implementation needs a Postgres-backed dedupe store — multi-file, not single-shot. Premissa 10 (idempotency mandatory) is real, but the right fix is a `packages/api/`-side store, not a serverless-lane patch. Flagged for human triage.
5. **Repair the chronic `packages/api` build break.** Multi-file TS1xxx fix across three files in a hot path. Worker memory says the issue is recurring (Z9.1 #23, Z22 follow-up). Not a single-shot mission — needs a focused human-led repair PR.
6. **Z29.4 zombie sentinel chain (9+ open sentinel PRs).** Orchestrator-side UUID stickiness, not a code mission.

---

## Supabase write status

Mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. Per worker memory `feedback_supabase_mcp_unavailable.md`, the Supabase MCP is **not granted to mission workers** — the SQL companion file (`4f79ec06-backlog-refill.sql`) is the canonical payload. Orchestrator (or a human operator with the service-role key) applies it on merge. All statements wrapped in a single `BEGIN/COMMIT` so partial application is impossible.

---

## Deliverables

- `docs/discovery/4f79ec06-backlog-refill.md` — this rationale doc
- `docs/discovery/4f79ec06-backlog-refill.sql` — 5 `INSERT` rows for `fabric_squad_missions` + 1 `fabric_audit_journal` event of type `auto_regen_executed`

No source code touched. No build-lane impact. Wallet-less rule preserved. Brand discipline: zero Claude/Anthropic references; co-author tag is Veridian Fabric.
