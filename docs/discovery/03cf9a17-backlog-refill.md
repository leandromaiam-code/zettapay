# Auto-discovery backlog refill — 03cf9a17

**Generated:** 2026-05-16
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `03cf9a17`
**Prior refills (recent):**

| PR  | UUID prefix | Theme                           |
|-----|-------------|---------------------------------|
| #231 | fba46358   | SDK webhook helpers + ENV doc + bug-bounty link |
| #242 | 69cdcbce   | 5 Z33E site-launch fixes (OG, robots, lang, signup) |
| #244 | 4f79ec06   | SDK re-exports + Vercel CORS + /api/pay rate-limit headers |

The prior three refills drained the site-launch queue, the SDK public-API parity queue, and the Vercel-edge HTTP-header queue. This pass scans **three previously-unaddressed surfaces** — **TS SDK module test coverage**, **CI gating per SDK language**, and **root-level developer-experience + RFC-9116 trust signals** — for single-objective, single-file, auto-mergeable gaps untouched by any open or recently-merged PR.

---

## Picks

| # | Mission name (≤60 chars)                                          | Target file                                          | LOC est. | Layer 0          |
|---|-------------------------------------------------------------------|------------------------------------------------------|----------|------------------|
| 1 | `sdk: cover client.ts with vitest`                                | `packages/sdk/test/client.test.ts` (new)             | ~140     | 29 (coverage)    |
| 2 | `chore: pin Node 20 via .nvmrc`                                   | `.nvmrc` (new)                                       | 1        | 26 (DX)          |
| 3 | `security: ship public/.well-known/security.txt (RFC 9116)`       | `public/.well-known/security.txt` (new)              | ~12      | 19 (bug bounty)  |
| 4 | `ci(sdk-rust): cargo check + clippy + test workflow`              | `.github/workflows/sdk-rust.yml` (new)               | ~35      | 23, 29           |
| 5 | `ci(sdk-python): pytest + ruff workflow`                          | `.github/workflows/sdk-python.yml` (new)             | ~35      | 23, 29           |

All five are **pure additive**, **single-file**, **single-objective**, and **outside the chronic `packages/api` build-break lane** (worker memory `project_build_broken.md`). None touch wallet code.

---

## Per-pick rationale

### 1. `sdk: cover client.ts with vitest`

`packages/sdk/src/client.ts` is **149 lines of public SDK surface** and has **zero direct test coverage** — every other module in `packages/sdk/src/` (`derive`, `errors`, `helpers`, `onchain`, `solana-pay`, `webhook`) ships a peer file in `packages/sdk/test/`. The TS SDK is `@zettapay/sdk` on npm (canonical SDK per Premissa 23); leaving the entry-point client untested means a future axios interceptor or constructor-default refactor can break public consumers silently.

Premissa 29: coverage > 70% on critical paths. The client is the most critical path — every SDK consumer instantiates it.

Test framework is already wired: `packages/sdk/package.json` has `"test": "vitest run"` + `vitest ^2.1.8`. Standard pattern is to mock axios via vitest's `vi.mock('axios')` (matching `helpers.test.ts`).

**Anti-scope:** do NOT refactor `client.ts`; tests only. Do NOT add `axios-mock-adapter` or `nock` as a new dep — use `vi.mock`.

### 2. `chore: pin Node 20 via .nvmrc`

Root has `"engines": { "node": ">=18.18" }` (loose). `.github/workflows/npm-publish.yml` already pins `node-version: '20'`. There is **no `.nvmrc`** at the repo root, so `nvm use` / `fnm use` / `asdf` / `volta` all fall back to whatever the contributor happens to have installed. New contributors hit cryptic TypeScript errors when they're on Node 18 and a workspace uses syntax Node 20 supports.

**Scope:** single file, single line: `20`. Match the version `npm-publish.yml` already uses. Do not change `engines` (separate breaking-change discussion).

### 3. `security: ship public/.well-known/security.txt (RFC 9116)`

Premissa 19 mandates a `$50k public bug bounty pre-mainnet`. The `audit/BUG_BOUNTY.md` ships in-repo, but **`https://zettapay.vercel.app/.well-known/security.txt` 404s** — there is no `public/.well-known/` directory. RFC 9116 is the industry-standard discovery mechanism for security researchers (every Stripe-grade payments site ships one). Researchers running automated `securitytxt.org` scrapers won't find the bounty link.

**Scope:** one file at `public/.well-known/security.txt` with the standard fields (Contact, Expires, Encryption optional, Preferred-Languages, Canonical, Policy). Vercel serves `public/` as static assets so the file is reachable without route config.

### 4. `ci(sdk-rust): cargo check + clippy + test workflow`

`packages/sdk-rust/` has shipped `Cargo.toml`, `src/lib.rs`, `src/webhook.rs`, `tests/integration.rs`, `tests/webhook.rs` — a full library crate. But `.github/workflows/` contains **only `npm-publish.yml` and `sdk-go.yml`** — Rust changes ship to crates.io / `main` with **no CI gate**. The Go SDK already has a per-push / per-PR `cargo`-equivalent workflow (`sdk-go.yml`); Rust parity is missing.

Premissa 29: Quality Gate. Premissa 23: SDK-first → all canonical SDKs must have CI.

**Scope:** one new workflow file at `.github/workflows/sdk-rust.yml`. Trigger on `push: main` + `pull_request` with `paths: 'packages/sdk-rust/**'`. Steps: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build --all-targets`, `cargo test --all-targets`. Match the structure of `sdk-go.yml`.

### 5. `ci(sdk-python): pytest + ruff workflow`

Identical gap for Python: `packages/sdk-python/tests/` has `conftest.py`, `test_async_client.py`, `test_client.py`, `test_webhook.py` — a real test suite — but **nothing in CI runs them**. The `pyproject.toml` already declares `[project.optional-dependencies] test = ["pytest>=7", "pytest-asyncio>=0.21"]`. We're one workflow file away from gating.

Premissa 23 + Premissa 29.

**Scope:** one new workflow file at `.github/workflows/sdk-python.yml`. Trigger on `push: main` + `pull_request` with `paths: 'packages/sdk-python/**'`. Steps: `pip install -e .[test]`, `pip install ruff`, `ruff check zettapay tests`, `pytest tests/ -v`. Matrix on Python 3.9/3.11/3.13 (matching the `classifiers` block).

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen because they fail one or more of {single-file, single-objective, auto-mergeable, non-controversial, outside chronic-broken lane}:

- **SECURITY.md at repo root** — overlaps trust-signal-wise with pick #3; GitHub already renders `.well-known/security.txt` indirectly via the Security tab when present. Pick the network-discoverable one first; SECURITY.md is a separate later mission.
- **CONTRIBUTING.md at repo root** — each SDK already has its own; root-level CONTRIBUTING needs a strategic call on per-SDK vs monorepo-wide guidance. Not auto-merge scope.
- **.editorconfig at repo root** — useful but bikeshed-prone (tab width, charset); leave as separate mission.
- **CSP / X-Frame-Options / HSTS headers in `vercel.json`** — Premissa 22 says CSP "configured in middleware", but ZettaPay is Vercel-headers-config not middleware. An aggressive CSP can break inline scripts on `pay.html` / `dashboard.html`. Needs page-by-page audit, not auto-merge.
- **Full SDK-Go / SDK-PHP build-out** — multi-file, multi-week effort; not single-objective.
- **`api/_lib/base58.ts` test file** — `api/` has no vitest runner wired (root `package.json` `test` walks workspaces; `api/` is not a workspace). Adding tests requires also adding test infra. Not single-file.
- **`packages/api` chronic build break** — multi-file structural fix in the chronic-broken compile lane (worker memory). Human triage.
- **Z29.4 / Z28.5 / Z30.x zombie sentinel chains** — orchestrator-side UUID stickiness, not code missions.
- **Retire legacy `dashboard.html` / consolidate dashboard surface** — routing decision, needs human call (worker memory `project_dashboard_analytics_split.md`).

---

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"` against this PR's diff returns **only documentary references** (this rationale doc + SQL comments quoting the rule). No code in the proposed missions calls `connect()` or imports wallet-adapter UI.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run build` state on this branch is identical to `main` — the chronic `packages/api` TS1xxx break is unchanged; this PR cannot have introduced or repaired it.

## Zombie sanity

Cross-referenced the last 50 merged PRs (#194..#244) + the rolling sentinel log (worker memory `project_zombie_sentinel_log.md`) + the three prior refill SQL companions (`fba46358`, `69cdcbce`, `4f79ec06`). **None of the 5 mission names** in this refill collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. The Supabase MCP is not granted to mission workers (worker memory `feedback_supabase_mcp_unavailable.md`); the SQL companion file `docs/discovery/03cf9a17-backlog-refill.sql` is the canonical payload. **Orchestrator (or human operator with service-role key) applies it on merge.** All statements are wrapped in a single `BEGIN/COMMIT` so partial application is impossible.
