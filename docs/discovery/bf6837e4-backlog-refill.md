# Auto-discovery backlog refill — bf6837e4

Eighth auto-discovery pass for workspace **zettapay**
(`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`). Source mission UUID prefix:
`bf6837e4`. Generated 2026-05-17.

## Prior seven refills

| PR   | UUID prefix | Theme                                                                          |
|------|-------------|--------------------------------------------------------------------------------|
| #231 | `fba46358`  | Single-objective dev miscellany (SDK errors.ts, LOG_PRETTY docs, Immunefi, sdk-python + sdk-rust webhook) |
| #242 | `69cdcbce`  | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff  |
| #244 | `4f79ec06`  | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| #245 | `03cf9a17`  | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust + sdk-python CI |
| #251 | `1986ee3d`  | SDK parity + supply chain — sdk-go + sdk-php webhook, sdk-php CI, dependabot, embed size budget |
| #252 | `a82d92db`  | SDK test + MCP discovery — sdk-go errors+retry test, sdk-python errors test, `.well-known/mcp.json`, `.editorconfig` |
| #253 | `9db4cb78`  | Cross-SDK + HARD-rule + onboarding — sdk-rust error inline test, sdk-go quickstart, sitemap.xml, wallet-less CI gate, root CONTRIBUTING.md |

This pass targets the **next-layer** polyglot gaps the prior seven did not
queue: PHP gets a quickstart example (last SDK without one),
Go gets its per-SDK CONTRIBUTING.md (last SDK without one), Python
gets a freeze + equality test for its public dataclasses, GitHub gets
its CodeQL security workflow, and the repo gets a `.tool-versions`
for asdf / mise users.

## 5 picks (single-objective, single-file, additive)

| # | Mission | Target file | Layer 0 |
|---|---|---|---|
| 1 | `sdk-php: examples/quickstart.php` | `packages/sdk-php/examples/quickstart.php` | 23, 25 |
| 2 | `sdk-go: per-SDK CONTRIBUTING.md` | `packages/sdk-go/CONTRIBUTING.md` | 25, 31 |
| 3 | `sdk-python: tests/test_types.py` | `packages/sdk-python/tests/test_types.py` | 23, 29 |
| 4 | `ci: CodeQL security workflow` | `.github/workflows/codeql.yml` | 18, 29 |
| 5 | `chore: .tool-versions polyglot lock` | `.tool-versions` | 25, 31 |

## Why these five

### 1. sdk-php quickstart (`packages/sdk-php/examples/quickstart.php`)

`packages/sdk-rust/examples/quickstart.rs` and
`packages/sdk-python/examples/quickstart.py` already ship; `sdk-go`
quickstart is queued in `9db4cb78` (PR #253). `sdk-php` is the **last
SDK** without a quickstart example — verified `ls packages/sdk-php/
examples/` returns "No such file or directory". The PHP SDK ships a
synchronous PSR-7/17/18 surface (`ZettaPay\Client`, `health()`,
`pay()`, etc.) so the example shape mirrors the Rust quickstart
without any async ceremony. Premissa 23 (SDK-first multi-language
parity) + Premissa 25 (DevRel + open SDK > paid marketing —
first-touch developers copy the example).

### 2. sdk-go per-SDK CONTRIBUTING.md (`packages/sdk-go/CONTRIBUTING.md`)

`packages/sdk-rust/CONTRIBUTING.md` and
`packages/sdk-python/CONTRIBUTING.md` both exist on main. `sdk-go`
has **none** (verified `ls`). The root CONTRIBUTING.md is queued in
`9db4cb78` (PR #253) and serves as the monorepo entry point — but the
per-SDK file is canonical for language-specific tooling commands
(`go test ./...`, `go vet ./...`, module path import, Go version
requirement from go.mod). Without it, Go contributors land in the
README and guess the toolchain. Premissa 25 + Premissa 31 (open
source: SDKs MIT — contribution path must be public).

### 3. sdk-python types freeze + equality test (`packages/sdk-python/tests/test_types.py`)

Listed explicitly as a **known follow-up** in the `9db4cb78` audit
payload ("sdk-python: tests/test_types.py for the dataclass exports").
`packages/sdk-python/zettapay/types.py` exports seven `frozen=True`
dataclasses (`Merchant`, `ListMerchantsResponse`, `PaymentRecord`,
`PayResponse`, `ListPaymentsResponse`, `HealthStatus`,
`_ApiErrorBody`) plus the mutable `RetryPolicy`. The freeze
invariant is what consumers depend on for safe sharing across
threads / async tasks — if a future refactor accidentally drops
`frozen=True`, no test catches it. Equality is `__eq__` auto-derived
by `@dataclass`; both invariants must be locked. Premissa 23 +
Premissa 29 (coverage > 70% on critical paths — public types are
the consumer-facing contract).

### 4. CodeQL security workflow (`.github/workflows/codeql.yml`)

Listed explicitly as a **known follow-up** in the `9db4cb78` audit
payload ("CodeQL static-analysis workflow"). GitHub-native CodeQL is
free for public repos, runs zero-config for JavaScript / TypeScript /
Python / Go (covers four of five SDKs out of the box), and feeds the
Security tab — the canonical surface auditors expect. Premissa 18
(smart contracts audited before mainnet — but the off-chain SDK
surface also needs a baseline scan) + Premissa 29 (quality gate).

Rust is **not** covered by stock CodeQL (extension-only via
`github/codeql-action/init` with `rust` is still beta and requires an
explicit opt-in we defer); the workflow scans the supported languages
only.

### 5. `.tool-versions` polyglot lock (`/.tool-versions`)

The repo is now genuinely polyglot — TypeScript (Node 18.18+), Go
1.22+, Python 3.9+, Rust stable, PHP 8.1+. `.nvmrc` (queued in
`03cf9a17` PR #245) covers Node only. `asdf` / `mise` users read
`.tool-versions` to provision every toolchain in one command (`asdf
install`). Without it, contributors juggle `.nvmrc` + `go.mod`'s
`go 1.22` + `python_requires>=3.9` in `pyproject.toml` + `cargo`'s
`rust-version` + `composer.json`'s `"php": "^8.1"` and hope they
match. Premissa 25 + Premissa 31.

`.tool-versions` is a flat key/value file with one tool per line. No
build step, no workflow. Anyone with vanilla `node` / `go` / `python`
/ `cargo` / `php` continues unchanged — the file is purely additive
for asdf / mise users.

## Wallet-less HARD rule

Every pick was greenlit against the CLAUDE.md banned-string list:

- **#1** `quickstart.php` — uses `$apiKey`, `$baseUrl`, env vars, and
  a base64 pre-signed transaction blob. No `wallet.connect`.
- **#2** `CONTRIBUTING.md` — markdown only; the wallet-less CI gate
  (queued in `9db4cb78`) excludes `.md` from scanning. The doc
  **mentions** the banned strings to inform contributors; this is
  intentional and matches the root CONTRIBUTING.md spec.
- **#3** `test_types.py` — pure dataclass freeze / equality / field
  shape assertions. Vacuous.
- **#4** `codeql.yml` — YAML workflow; the wallet-less CI gate
  excludes `.yml` from scanning. Vacuous.
- **#5** `.tool-versions` — three to five plain-text version pins.
  Vacuous.

## Safe lane

- `packages/sdk-php/examples/quickstart.php` — runs under existing
  `composer.json` autoload (`ZettaPay\` PSR-4). Gated by `composer
  validate` and `php -l examples/quickstart.php`. CI gate
  `ci(sdk-php): phpunit workflow` (queued in `1986ee3d` PR #251) is
  the broader gate but does not need to run the example.
- `packages/sdk-go/CONTRIBUTING.md` — markdown only, no compile lane.
- `packages/sdk-python/tests/test_types.py` — pure pytest, gated by
  `ci(sdk-python): pytest + ruff workflow` (queued in `03cf9a17`
  PR #245).
- `.github/workflows/codeql.yml` — workflow only; first run after
  merge is the only validation.
- `.tool-versions` — additive plain-text file, zero compile impact.
- **None** touch the chronic-broken `packages/api` compile lane
  (worker memory `project_build_broken.md`).

## SQL companion

`docs/discovery/bf6837e4-backlog-refill.sql` ships:

- 5 × `INSERT INTO fabric_squad_missions` (full detailed prompt body,
  escaped via `$$ … $$`).
- 1 × `INSERT INTO fabric_audit_journal` with `event_type =
  'auto_regen_executed'` and full payload (prior refills, missions
  inserted, themes, safe lanes, avoids, known follow-ups).
- All wrapped in `BEGIN; … COMMIT;` (no partial application possible).

Worker cannot reach Supabase MCP directly (worker memory
`feedback_supabase_mcp_unavailable.md`); the orchestrator or a human
operator with the service-role key applies on merge.

## Test plan

- [x] All 5 target files verified missing on `main` (HEAD `89b0b90`) —
      `ls`-checked.
- [x] No open PR conflicts — names cross-checked against every queued
      mission across the seven prior refills.
- [x] SQL is balanced (1 `BEGIN` / `COMMIT`, 6 `INSERT`s, 10 `$$`
      markers = 5 pairs).
- [x] Wallet-less grep — every file in this PR passes the gate
      queued by `9db4cb78`, EXCEPT `.md` / `.yml` (which the gate
      excludes) and this companion doc.
- [x] Brand discipline — no Claude / Anthropic mentions; no
      revolution / disruption / synergy / game-changer copy.
- [x] Docs only — `git diff --stat` will show exactly two files added:
      `docs/discovery/bf6837e4-backlog-refill.{md,sql}`. Nothing else.
- [ ] Orchestrator applies SQL on merge (post-merge step).

## Known follow-ups (deferred this pass, captured in audit payload)

- `sdk-rust: examples/webhook.rs` — mirrors Go webhook example queued
  earlier; defer until Go webhook example lands so both can share
  fixture shape.
- `sdk-go: examples/webhook.go` — already in `9db4cb78` known
  follow-ups; remains deferred.
- `sdk-php: tests for webhook + retry` — exists in `1986ee3d` queue;
  do not duplicate.
- `sdk-python: tests/test__http.py` — already in `9db4cb78` known
  follow-ups; remains deferred (transport-fake fixture mission).
- `license-checker` CI workflow — separate mission, needs allow-list
  policy decision.
- `CodeQL Rust language pack` — beta opt-in; defer until upstream
  GA.
- `CODEOWNERS` — still deferred; needs human owner/team decision.
- `public/manifest.json` PWA shell — still deferred; needs service
  worker mission.
- `CHANGELOG.md` per-SDK — still deferred; needs version policy
  decision.
- `.mise.toml` — `.tool-versions` is the lowest-common-denominator
  (asdf + mise both read it); `.mise.toml` adds nothing until task
  runners are needed.
