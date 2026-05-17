# Auto-discovery backlog refill — 2e05f052

**Generated:** 2026-05-17
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `2e05f052`
**Prior refills (recent):**

| PR  | UUID prefix | Theme                                                                                  |
|-----|-------------|----------------------------------------------------------------------------------------|
| #251 | `1986ee3d`  | SDK parity + supply chain — sdk-go/php webhook, sdk-php CI, dependabot, embed budget   |
| #252 | `9db4cb78`  | SDK test coverage + MCP discovery + editorconfig                                       |
| #253 | `07e4ac3`*  | cross-SDK + HARD-rule + onboarding                                                     |
| #254 | `4848330`*  | polyglot SDK + CodeQL + tool-versions                                                  |
| #257 | `4330964`*  | .github + SDK-PHP hygiene                                                              |
| #258 | `af9fd69`*  | TS-lane npm-meta + .gitattributes + sdk-ts CONTRIBUTING                                |
| #259 | `87fcb3c`*  | wallet-less HARD-rule rewrites + sdk-php Packagist support                             |

*SHA prefixes shown when mission UUID wasn't echoed in the commit body.

The seven prior refills drained the per-SDK CI lane (rust/python/php), the
per-SDK CONTRIBUTING lane, the root npm/composer/cargo metadata lane, the
wallet-less HARD-rule rewrite lane, the supply-chain (dependabot/CodeQL),
and the trust-signal lane (security.txt, SECURITY.md, sitemap.xml,
.well-known/mcp.json). This pass scans **four previously-unaddressed surfaces**:

1. **Untested widget/embed modules** (`qr.ts`, `poll.ts` — only modules in
   their respective packages without peer test files).
2. **Dangling-reference cleanup** (`audit/HALL_OF_FAME.md` — referenced by
   the queued `security.txt` mission and explicitly flagged as known
   follow-up in pass `1986ee3d`).
3. **AI-agent discoverability** (`public/llms.txt` — Premissa 6/8 moat
   surface, never picked).
4. **Anchor static-analysis CI gating** (the offline `scripts/static-analysis-rust.sh`
   exists, is wired to `npm run audit:static-rust`, but no workflow runs it
   on every PR — Premissa 18 mainnet pre-req).

---

## Picks

| # | Mission name (≤60 chars)                                       | Target file                                            | LOC est. | Layer 0           |
|---|----------------------------------------------------------------|--------------------------------------------------------|----------|-------------------|
| 1 | `widget: cover qr.ts with vitest`                              | `packages/widget/test/qr.test.ts` (new)                | ~90      | 29 (coverage)     |
| 2 | `embed: cover poll.ts with vitest`                             | `packages/embed/test/poll.test.ts` (new)               | ~140     | 14, 29            |
| 3 | `audit: ship HALL_OF_FAME.md (security.txt referent)`          | `audit/HALL_OF_FAME.md` (new)                          | ~35      | 19 (bug bounty)   |
| 4 | `discovery: ship public/llms.txt (AI-agent protocol surface)`  | `public/llms.txt` (new)                                | ~60      | 6, 8, 25          |
| 5 | `ci(programs): wire static-analysis-rust.sh to GH Actions`     | `.github/workflows/static-analysis-rust.yml` (new)     | ~30      | 18, 29            |

All five are **pure additive**, **single-file**, **single-objective**, and
**outside the chronic `packages/api` build-break lane** (worker memory
`project_build_broken.md`). None touch wallet code or wallet-adapter UI.

---

## Per-pick rationale

### 1. `widget: cover qr.ts with vitest`

`packages/widget/src/qr.ts` is **52 lines of pure-logic SVG generation** and
the only widget module without a peer test file. Today
`packages/widget/test/` holds only `widget.test.ts` — `api.ts`, `modal.ts`,
`qr.ts`, `styles.ts`, `types.ts` are uncovered. Of those, `qr.ts` is the
single best pick because:

- It's **pure-logic** (input `payload: string` → output `string` SVG), no DOM,
  no network, no timers. Trivially testable.
- It's a **trust surface**: the QR is what customers scan to pay — any
  silent regression (off-by-one cell, wrong viewBox, broken `<rect>`)
  prints a QR that doesn't decode, and the merchant loses the sale.
  Premissa 29 (coverage > 70% on critical paths) and the wallet-less
  HARD-rule (QR is the canonical hand-off) both point here.
- `modal.ts` / `styles.ts` are DOM-coupled (need jsdom plus more scaffolding);
  `types.ts` is type-only. `api.ts` is the next candidate but is HTTP-shaped
  (better tested via mocked fetch + happy/error paths — separate mission).

Test framework is wired: `packages/widget/vitest.config.ts` exists and
`packages/widget/test/widget.test.ts` is the working pattern to mirror.

**Anti-scope:** do NOT refactor `qr.ts`; tests only. Do NOT introduce
`@vitest/snapshot` for SVG-output assertions — snapshot churn obscures
real regressions. Assert structurally (substring + cell count + viewBox).

### 2. `embed: cover poll.ts with vitest`

`packages/embed/src/poll.ts` is **118 LOC of settlement-detection logic** —
the single most load-bearing module in the embed (Premissa 14: we don't
custody; polling correctness is the only way merchants learn they were
paid). Today `packages/embed/test/` has `embed.test.ts` + `wallets.test.ts`;
`poll.ts`, `rpc.ts`, `ui.ts`, and `types.ts` are uncovered.

`poll.ts` exports `startPoller(params): Poller`; the loop calls
`getSignaturesForAddress` + `getParsedTransaction` from `./rpc.js` (clean
seam to mock), de-dupes via a `Set<string>`, and reports the first matching
`(mint, amountBaseUnits, recipient)` transfer via `onMatch`.

The cases to cover:

- Happy path — one matching signature in the second tick fires `onMatch`
  with `(signature, blockTime)` and the poller stops itself.
- De-dup — the same signature returned twice across two ticks doesn't fire
  `onMatch` twice.
- Amount mismatch — a transfer to the recipient with the wrong amount does
  NOT fire `onMatch`.
- Mint mismatch — a transfer with the wrong mint does NOT fire `onMatch`.
- Error tolerance — `getSignaturesForAddress` throws → `onError` called,
  loop continues to next tick.
- `stop()` — after `stop()`, no further RPC calls or `onMatch` invocations
  happen even if pending ticks fire.

Mock `./rpc.js` via `vi.mock('../src/rpc.js', ...)`. Use `vi.useFakeTimers()`
+ `await vi.advanceTimersByTimeAsync(intervalMs)` for deterministic loop
advancement (pattern from `packages/sdk/test/helpers.test.ts` if it exists,
or standard vitest fake-timers usage).

**Anti-scope:** do NOT refactor `poll.ts`; tests only. Do NOT add real
RPC integration — use mocks. Do NOT cover `rpc.ts` / `ui.ts` in the same
PR (separate missions; they have different mock seams).

### 3. `audit: ship HALL_OF_FAME.md (security.txt referent)`

The queued mission `security: ship public/.well-known/security.txt` (uuid
prefix `03cf9a17`, queued in PR-to-be) lists
`Acknowledgments: https://github.com/leandromaiam-code/zettapay/blob/main/audit/HALL_OF_FAME.md`
as one of seven required RFC-9116 fields. **That URL 404s** —
`audit/HALL_OF_FAME.md` does not exist. The dangling reference was flagged
as a known follow-up in pass `1986ee3d` line 58-63 but explicitly left for
the next pass since `security.txt` itself hadn't landed yet.

`security.txt` will land soon (its mission is queued); we should ship the
target file **in advance** so that on the day `security.txt` deploys, the
`Acknowledgments` URL resolves rather than 404-ing on security researchers'
first click. Premissa 19 ($50k public bug bounty pre-mainnet) treats
researcher experience as part of the bounty surface.

**Scope:** one new file `audit/HALL_OF_FAME.md`, ~30-50 lines markdown:

- Heading: `# ZettaPay Hall of Fame — Security Researchers`
- Short paragraph explaining the page: who's listed and why, when entries
  are added (post-disclosure + post-patch, with researcher consent).
- A `## How to be listed` section pointing to `audit/BUG_BOUNTY.md` for
  the report-flow and `mailto:security@zettapay.dev` for contact.
- An empty `## 2026` H2 section with a one-liner placeholder
  (`_No public disclosures yet. Be the first._`).
- Final line linking back to `security.txt` once it deploys.

**Anti-scope:** do NOT invent fictional researcher names. Do NOT promise
specific reward tiers — those live in `BUG_BOUNTY.md`. Do NOT add a
table of CVEs (premature; we have no public disclosures yet).

### 4. `discovery: ship public/llms.txt (AI-agent protocol surface)`

ZettaPay's primary persona (Premissa 6/8) is **AI agents** (Claude / GPT /
Gemini) paying via x402 + MCP. There is **no `public/llms.txt`** — the
emerging community standard (proposed by Jeremy Howard, adopted by
Anthropic-docs, Mintlify, Vercel) for telling LLM crawlers in plain text:

- What this site is
- Where the canonical docs live
- Where the LLM-friendly per-page-markdown lives (`/docs/*.md`)
- What the public protocol surfaces are (x402 spec link, MCP server URL,
  `/.well-known/mcp.json` discovery)

Premissa 8 ("AI Agent Marketplace is the moat of long-term — first-mover
advantage") and Premissa 25 ("DevRel + open SDK > paid marketing") both
point at making the protocol maximally **agent-discoverable**, in the same
spirit `security.txt` makes the bounty researcher-discoverable. The cost
is one ~60-line plain-text file.

The file format is loose (no RFC yet); de-facto convention is markdown
with H1 = site name, H2 sections for {Overview, Docs, Optional}, and
bullet lists of canonical URLs with one-line descriptions.

**Scope:** one new file `public/llms.txt` covering:

- H1: `# ZettaPay`
- 1-2 sentence summary mirroring the README opening (multicoin,
  non-custodial, P2P confirmation-tracking; **no** banned 0.30%/MoonPay
  claims per worker memory `project_canon_2026_05_16.md`).
- `## Docs` block linking the canonical pages (`/docs/quickstart`,
  `/docs/api`, `/docs/webhook`, `/docs/embed`).
- `## Protocol surfaces` block linking the public spec URLs:
  `/.well-known/mcp.json` (already queued), `/api/mcp`, GitHub repo,
  the canonical x402 spec URL (e.g. `https://github.com/coinbase/x402`
  or whatever the executor confirms as authoritative).
- `## Optional` block linking `/sitemap.xml` (already queued) for
  exhaustive crawl, `/audit/BUG_BOUNTY.md` for the security contact.

**Anti-scope:** do NOT add `User-Agent: GPTBot Allow: /` style robots
directives — that belongs in `public/robots.txt` (separate mission).
Do NOT add prices, fee claims, or marketing copy banned by worker memory
`project_canon_2026_05_16.md`. Plain protocol facts only.

### 5. `ci(programs): wire static-analysis-rust.sh to GH Actions`

`scripts/static-analysis-rust.sh` is a **152-line offline Sec3-X-ray + Soteria
heuristics scan** that codifies the eight check classes (X-001..X-008 +
S-001..S-002) the mainnet audit prep (Premissa 18 / Z21) requires. It's
wired to `npm run audit:static-rust` in root `package.json`. But the only
workflows in `.github/workflows/` today are `npm-publish.yml` and
`sdk-go.yml` — **no PR runs `audit:static-rust`**.

The script is idempotent, has no network deps, and finishes in
single-digit seconds (it greps and counts on the rust source). Wiring it
to a workflow is one new file. Premissa 18 (smart contracts audited
before mainnet) is the load-bearing rule; this is the offline complement
to the cloud Sec3 / Halborn scans that run only at audit milestones.

**Scope:** one new file `.github/workflows/static-analysis-rust.yml`:

```yaml
name: static-analysis-rust

on:
  push:
    branches: [main]
    paths:
      - 'programs/zettapay/**'
      - 'scripts/static-analysis-rust.sh'
      - '.github/workflows/static-analysis-rust.yml'
  pull_request:
    paths:
      - 'programs/zettapay/**'
      - 'scripts/static-analysis-rust.sh'
      - '.github/workflows/static-analysis-rust.yml'

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Run static analysis
        run: bash scripts/static-analysis-rust.sh
```

No setup-rust (the script does pure grep/awk on .rs files). No matrix.
Trigger on changes to `programs/` or the script itself (or its workflow).

**Anti-scope:** do NOT modify `static-analysis-rust.sh` in this PR — wiring
only. Do NOT add Sec3 / Soteria cloud-runner steps (those need secrets +
billing). Do NOT promote to required-status-check (separate repo-admin
mission). Do NOT run from any subdirectory — script paths are repo-root
relative.

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen
because they fail one or more of {single-file, single-objective,
auto-mergeable, non-controversial, outside chronic-broken lane}:

- **`packages/widget/test/{api,modal,styles}.test.ts`** — `api.ts` needs
  fetch mocking infra; `modal.ts` + `styles.ts` need jsdom setup. Each
  becomes its own mission once `qr.test.ts` lands and proves the widget
  vitest config is stable.
- **`packages/embed/test/{rpc,ui}.test.ts`** — `rpc.ts` is wrapped fetch
  (good single-file pick for next pass once `poll.test.ts` proves the
  mock seam); `ui.ts` is jsdom-coupled (later).
- **`CHANGELOG.md` at root** — release-ops decision (manual vs Changesets
  vs Release-Please vs conventional-commits-driven). Already rejected
  three times in prior passes; needs a strategic call, not auto-merge.
- **`.github/FUNDING.yml`** — already rejected as "bikeshed (which sponsor
  target)" in two prior passes. Need stakeholder input.
- **`audit/HALL_OF_FAME` as part of `security.txt` mission** — splitting
  it out as pick #3 here lets `security.txt` (queued in `03cf9a17`) stay
  single-file. Don't bundle.
- **`packages/sdk-go/{retry,errors}_test.go`** — already queued in pass
  `9db4cb78`.
- **`scripts/static-analysis-rust.sh` change to fail on warnings instead
  of just errors** — script-modification mission, not CI-wiring mission.
- **`programs/zettapay/Cargo.toml` add keywords/categories/repository for
  crates.io publish** — `cdylib` is primarily an on-chain program, not a
  typical crates.io target. Strategic call.
- **`Anchor.toml` cluster / wallet / programs-deployed configuration
  hardening** — multi-line, multi-environment; auditor-reviewed material.
  Human triage.
- **`packages/api` chronic build break** — multi-file structural fix in
  the chronic-broken compile lane (worker memory). Human triage.
- **Zombie sentinel chains (Z29.4 / Z28.5 / Z30.x / Z19.2)** —
  orchestrator-side UUID stickiness, not code missions.

---

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"`
against this PR's diff returns **only documentary references** (this
rationale doc + SQL companion quoting the rule + `llms.txt` describing the
protocol surface). No code in the proposed missions calls `connect()` or
imports wallet-adapter UI.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run
build` state on this branch is identical to `main` — the chronic
`packages/api` TS1xxx break is unchanged; this PR cannot have introduced
or repaired it.

## Zombie sanity

Cross-referenced the last 50 merged PRs (#207..#259) + the rolling
sentinel log (worker memory `project_zombie_sentinel_log.md`) + the
eleven prior refill SQL companions (`fba46358`, `69cdcbce`, `4f79ec06`,
`03cf9a17`, `1986ee3d`, `9db4cb78`, `66b549af`, `a82d92db`, `bf6837e4`,
`d5806497`, `e365137f`). **None of the 5 mission names** in this refill
collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` +
`fabric_audit_journal`. The Supabase MCP is not granted to mission workers
(worker memory `feedback_supabase_mcp_unavailable.md`); the SQL companion
file `docs/discovery/2e05f052-backlog-refill.sql` is the canonical
payload. **Orchestrator (or human operator with service-role key) applies
it on merge.** All statements are wrapped in a single `BEGIN/COMMIT` so
partial application is impossible.
