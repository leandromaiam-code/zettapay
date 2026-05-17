# Auto-discovery backlog refill — 07b1ae9c

**Generated:** 2026-05-17
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `07b1ae9c`
**Prior refills (recent, last 12):**

| PR  | UUID prefix | Theme                                                              |
|-----|-------------|--------------------------------------------------------------------|
| #260 | 03cf9a17   | TS SDK client.ts tests + .nvmrc + .well-known/security.txt + sdk-rust/python CI |
| #259 | e365137f   | wallet-less HARD rule rewrites (widget keywords/README, embed README, root README) + sdk-php Packagist |
| #258 | 66b549af   | npm metadata (sdk/embed/widget) + .gitattributes + sdk-ts CONTRIBUTING |
| #257 | d5806497   | sdk-php CONTRIBUTING + SECURITY.md + PR template + ISSUE config + sdk-php Exception tests |
| #254 | bf6837e4   | sdk-php quickstart + sdk-go CONTRIBUTING + sdk-python test_types + CodeQL + .tool-versions |
| #253 | 9db4cb78   | sdk-rust error inline tests + sdk-go quickstart + sitemap + wallet-less CI gate + root CONTRIBUTING |
| #252 | a82d92db   | sdk-go errors/retry tests + sdk-python errors test + .well-known/mcp.json + .editorconfig |
| #251 | 1986ee3d   | sdk-go/sdk-php webhook verifiers + sdk-php CI + dependabot + embed size budget |
| #245 | 2e05f052   | widget/qr.test + embed/poll.test + HALL_OF_FAME + llms.txt + static-analysis-rust CI |
| #244 | 4f79ec06   | sdk-python/sdk-rust re-exports + vercel CORS + api/pay rate-limit headers + api/index discovery sync |
| #242 | 69cdcbce   | OG meta + /simulate footer removal + robots/sitemap + pay.html lang + signup hardening |
| #231 | fba46358   | sdk-python/sdk-rust webhook verifiers + sdk/errors.ts tests + LOG_PRETTY env doc |

The prior twelve refills drained the wallet-less HARD-rule rewrite queue, the per-SDK polyglot hygiene queue, the GitHub-trust-signal queue (SECURITY.md, ISSUE_TEMPLATE config, PR template, well-known files), the per-SDK CI gating queue, the TS-lane npm-metadata queue, and the site-launch SEO queue. This pass scans **five previously-unaddressed surfaces** — **safe-subset Vercel security headers**, **next-pass test coverage for embed/rpc.ts and widget/api.ts**, **per-crate LICENSE parity (sdk-rust only)**, and a **`.github/SUPPORT.md` re-router** — for single-objective, single-file, auto-mergeable gaps untouched by any open or recently-merged PR.

---

## Picks

| # | Mission name (≤60 chars)                                           | Target file                                          | LOC est. | Layer 0           |
|---|--------------------------------------------------------------------|------------------------------------------------------|----------|-------------------|
| 1 | `chore(vercel): safe security headers — nosniff + referrer + perms`| `vercel.json` (modify `headers[]`)                   | ~22      | 22                |
| 2 | `test(embed): cover rpc.ts (wrapped fetch + RPC helpers)`          | `packages/embed/test/rpc.test.ts` (new)              | ~130     | 29                |
| 3 | `test(widget): cover api.ts (createPaymentIntent + pollPaymentStatus)` | `packages/widget/test/api.test.ts` (new)         | ~180     | 29                |
| 4 | `chore(sdk-rust): ship LICENSE at crate root (crates.io)`          | `packages/sdk-rust/LICENSE` (new)                    | ~21      | 23, 31            |
| 5 | `chore(.github): SUPPORT.md routing to existing surfaces`          | `.github/SUPPORT.md` (new)                           | ~40      | 25, 31            |

All five are **pure additive**, **single-file**, **single-objective**, and **outside the chronic `packages/api` build-break lane** (worker memory `project_build_broken.md`). None touch wallet code.

---

## Per-pick rationale

### 1. `chore(vercel): safe security headers — nosniff + referrer + perms`

Today `vercel.json`'s `headers` block has **only one entry** (`/api/(.*)` → `Cache-Control: no-store` + `X-Powered-By: ZettaPay`). The entire static `public/` surface — `index.html`, `pay.html`, `dashboard.html`, `checkout.html`, `signup.html`, `pricing.html`, `launch.html`, `status.html`, `about.html`, `contact.html`, `privacy.html`, `terms.html`, the `docs/` folder, `embed.js`, the OG/logo PNGs — ships with **zero** security headers.

Premissa 22 says "CSP headers configured in middleware". For ZettaPay (no Next.js middleware) the equivalent is the Vercel headers config. Prior refill `03cf9a17` explicitly REJECTED the bundle of {CSP, X-Frame-Options, HSTS} because aggressive CSP can break inline scripts on `pay.html` / `dashboard.html` and `X-Frame-Options: SAMEORIGIN` would block the embed widget on third-party sites. This pick deliberately ships **only the safe subset** that those concerns don't touch:

- `X-Content-Type-Options: nosniff` — MIME-sniff protection. No behavioral change for any served asset; always safe.
- `Referrer-Policy: strict-origin-when-cross-origin` — current browser default for new sites; prevents leaking checkout/dashboard path segments to cross-origin destinations.
- `Permissions-Policy: interest-cohort=(), browsing-topics=()` — opts out of Chrome's tracking-cohort APIs; no behavioral change for payment flows.

**Anti-scope:** do NOT add CSP (page-by-page audit needed for Recharts + QR + MoonPay + the demo simulator). Do NOT add HSTS (Vercel terminates TLS already). Do NOT add `X-Frame-Options` (would break the embed widget by design).

### 2. `test(embed): cover rpc.ts (wrapped fetch + RPC helpers)`

`packages/embed/src/rpc.ts` is **103 lines of JSON-RPC envelope construction + fetch wrapping** on the embed.js critical path — every payment-detection tick calls `getSignaturesForAddress` + `getParsedTransaction`. Today `packages/embed/test/` holds only `embed.test.ts` + `wallets.test.ts`.

Prior refill `2e05f052` queued `poll.test.ts` and its rejected-candidates section explicitly flagged `rpc.ts` as the "good single-file pick for next pass once `poll.test.ts` proves the mock seam". This is that next-pass mission.

Premissa 29 (coverage > 70% on critical paths). A regression in JSON-RPC envelope construction or `RPC_URL`/`USDC_MINT` constants silently breaks payment detection in the wild.

**Anti-scope:** do NOT refactor `rpc.ts`. Do NOT add `msw` / `nock` / any dep — embed.js is "zero runtime dependencies" per its own README; tests use `vi.spyOn(globalThis, 'fetch')`.

### 3. `test(widget): cover api.ts (createPaymentIntent + pollPaymentStatus)`

`packages/widget/src/api.ts` is **167 lines** containing the widget's only network surface — every modal open hits `createPaymentIntent`, every payment confirmation goes through `pollPaymentStatus`. Today `packages/widget/test/` holds only `widget.test.ts`.

Prior refill `2e05f052` queued `qr.test.ts` and its rejected-candidates section listed `api.test.ts` as "the next candidate but is HTTP-shaped (better tested via mocked fetch + happy/error paths — separate mission)". This is that separate mission.

Premissa 29. The test surface is meaningful: idempotency-key generation (Stripe-pattern dedup on flaky networks), the always-injected `source: 'widget'` metadata, the 404 → retry semantics (read-replica lag), the trailing-slash trimming, the AbortSignal hook (modal close), and the 5-minute timeout fallback all need explicit coverage.

**Anti-scope:** do NOT refactor `api.ts`. Use `vi.useFakeTimers()` to avoid real 2.5s polling waits. Do NOT add `msw` / `nock` / any new dep — widget package devDeps are minimal by design.

### 4. `chore(sdk-rust): ship LICENSE at crate root (crates.io)`

Today `packages/sdk-rust/` declares `license = "MIT"` in `Cargo.toml` but has **no LICENSE file** at the crate root. Prior refill `e365137f` flagged per-SDK LICENSE parity (sdk-rust + sdk-python + sdk-go + sdk-php all missing) but rejected the BUNDLE as four separate missions. This is one of those four — sdk-rust — picked first because:

- crates.io publish guidelines specifically recommend shipping a LICENSE file at crate root so the crates.io detail page can display it inline.
- `license = "MIT"` alone produces a "License file not bundled" warning on `cargo publish`.
- The Rust SDK has the most-mature publishing pipeline (full `Cargo.toml` metadata: `repository`, `homepage`, `documentation`, `categories`, `keywords` all set).

Premissa 31 ("Open source: protocol spec + SDKs MIT") + Premissa 23 (SDK-first DX).

**Anti-scope:** do NOT touch the other three SDKs (each is a separate mission ordered by publication priority). Do NOT add dual-licensing (project is MIT-only). Do NOT modify `Cargo.toml` (the `license = "MIT"` field is already correct).

### 5. `chore(.github): SUPPORT.md routing to existing surfaces`

GitHub displays `.github/SUPPORT.md` as a "Get help" panel in the "New issue" flow and links it from the repo's community profile. Today the repo has no SUPPORT.md, so new contributors and security researchers open issues with no routing context — security reports, billing questions, and feature requests all land in the same `/issues` queue.

This mission is deliberately scoped to be **strictly a re-router** — it adds zero new email addresses, zero new chat channels, zero new support tiers. It ONLY links to surfaces that already exist in the repo (`docs/`, `protocol/`, `examples/`, the five SDK paths, `audit/BUG_BOUNTY.md`, `community/discord/`, the live `zettapay.vercel.app/status` page). So the rejection rationale that killed CHANGELOG / CODEOWNERS / FUNDING / CODE_OF_CONDUCT in prior refills — "needs ops decision" — does NOT apply: every link target already exists.

Premissa 25 (DevRel + open SDK > paid marketing) + Premissa 31 (open source trust signal).

**Anti-scope:** do NOT add a `support@zettapay.io` email. Do NOT add Slack / Telegram / pager links. Do NOT add SLA promises. Do NOT modify `README.md` — GitHub surfaces `.github/SUPPORT.md` automatically.

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen because they fail one or more of {single-file, single-objective, auto-mergeable, non-controversial, outside chronic-broken lane}:

- **`CHANGELOG.md` at root** — repeatedly rejected (in `2e05f052`, `66b549af`, `9db4cb78`, `bf6837e4`, `d5806497`, `e365137f`): release-ops decision (manual vs Changesets vs Release Drafter) not yet made.
- **`CODEOWNERS`** — repeatedly rejected (`9db4cb78`, `a82d92db`, `bf6837e4`, `d5806497`, `e365137f`): per-package ownership map needs a human owner/team decision.
- **`.github/FUNDING.yml`** — repeatedly rejected (`2e05f052`, `66b549af`, `d5806497`, `e365137f`): which sponsor target (GitHub Sponsors? Open Collective? Crypto address?) is a bikeshed.
- **`CODE_OF_CONDUCT.md`** — repeatedly rejected (`66b549af`, `d5806497`, `e365137f`): Contributor Covenant 2.1 is standard but enforcement contact needs an ops decision.
- **Aggressive CSP / HSTS / X-Frame-Options in `vercel.json`** — rejected in `03cf9a17`: needs page-by-page audit of inline scripts + iframe-embedding by design.
- **Per-SDK LICENSE for sdk-python / sdk-go / sdk-php** — each is a separate single-file mission (the bundle was rejected in `e365137f`); pick #4 ships sdk-rust as the first of the four, ordered by publication-pipeline maturity.
- **`packages/widget/test/{modal,styles}.test.ts`** — DOM-coupled, need jsdom scaffolding; separate missions once the widget vitest config is proven stable by the queued `qr.test.ts` landing.
- **`packages/embed/test/ui.test.ts`** — jsdom-coupled; separate later mission.
- **`packages/api/*` build break** — chronic compile lane (worker memory `project_build_broken.md`); not auto-merge.
- **`scripts/check-idl-drift.sh`** — would need Anchor toolchain in CI; the queued `static-analysis-rust.yml` (from `2e05f052`) is a better forcing function for that surface.
- **`SUPPORT.md` with new `support@zettapay.io` email** — needs ops decision; pick #5 deliberately avoids adding any new contact target.
- **Z29.4 / Z28.5 / Z30.x zombie sentinel chains** — orchestrator-side UUID stickiness, not code missions.

---

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"` against this PR's diff returns **only documentary references** (this rationale doc + SQL comments quoting the rule). No code in the proposed missions calls `connect()` or imports wallet-adapter UI.

The five mission targets themselves are also wallet-less by construction:

- `vercel.json` — config, no wallet code.
- `packages/embed/src/rpc.ts` — already wallet-less (JSON-RPC read-only).
- `packages/widget/src/api.ts` — already wallet-less (HTTP only; pubkey is a payload field, not a `connect()` source).
- `packages/sdk-rust/LICENSE` — plain text.
- `.github/SUPPORT.md` — markdown.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run build` state on this branch is identical to `main` — the chronic `packages/api` TS1xxx break is unchanged; this PR cannot have introduced or repaired it.

## Zombie sanity

Cross-referenced the last 60 merged PRs (#194..#260) + the open PR list (~50 zombie sentinels + 1 retry-feat) + the rolling sentinel log (worker memory `project_zombie_sentinel_log.md`) + the twelve prior refill SQL companions. **None of the 5 mission names** in this refill collide with prior or in-flight work.
