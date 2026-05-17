# Auto-discovery backlog refill — d5806497

Ninth auto-discovery pass for workspace **zettapay**
(`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`). Source mission UUID prefix:
`d5806497`. Generated 2026-05-17.

## Prior eight refills

| PR   | UUID prefix | Theme                                                                          |
|------|-------------|--------------------------------------------------------------------------------|
| #231 | `fba46358`  | Single-objective dev miscellany (SDK errors.ts tests, LOG_PRETTY, Immunefi, sdk-python + sdk-rust webhook) |
| #242 | `69cdcbce`  | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff  |
| #244 | `4f79ec06`  | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| #245 | `03cf9a17`  | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust + sdk-python CI |
| #251 | `1986ee3d`  | SDK parity + supply chain — sdk-go + sdk-php webhook, sdk-php CI, dependabot, embed size budget |
| #252 | `a82d92db`  | SDK test + MCP discovery — sdk-go errors+retry test, sdk-python errors test, `.well-known/mcp.json`, `.editorconfig` |
| #253 | `9db4cb78`  | Cross-SDK + HARD-rule + onboarding — sdk-rust error inline test, sdk-go quickstart, sitemap.xml, wallet-less CI gate, root CONTRIBUTING.md |
| #254 | `bf6837e4`  | Polyglot SDK + CodeQL + tool-versions — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-python test_types, CodeQL, `.tool-versions` |

The prior eight refills drained the polyglot **SDK quickstart**,
**SDK CI**, **per-SDK CONTRIBUTING (for rust/python/go)**, **MCP +
sitemap + security.txt discovery**, and **root-level DX + supply
chain** queues. This pass targets the **next-layer hygiene** the
prior eight did not queue: the **last SDK without CONTRIBUTING.md**
(PHP), the **GitHub-native trust signals** that pair with the
already-queued RFC-9116 `security.txt` (root `SECURITY.md` + an
`ISSUE_TEMPLATE/config.yml` that routes security reports
away from public issues), the **contributor-facing PR template**
absent across 250+ PRs of repo history, and the **only SDK
exception module without isolated test coverage** (PHP's three
typed exception classes).

## 5 picks (single-objective, single-file, additive)

| # | Mission name (≤60 chars)                                            | Target file                                          | LOC est. | Layer 0          |
|---|---------------------------------------------------------------------|------------------------------------------------------|----------|------------------|
| 1 | `sdk-php: ship per-SDK CONTRIBUTING.md`                             | `packages/sdk-php/CONTRIBUTING.md` (new)             | ~80      | 25, 31           |
| 2 | `security: ship root SECURITY.md (GitHub Security tab)`             | `SECURITY.md` (new)                                  | ~60      | 19               |
| 3 | `chore: .github/PULL_REQUEST_TEMPLATE.md`                           | `.github/PULL_REQUEST_TEMPLATE.md` (new)             | ~40      | 25, 26           |
| 4 | `chore: .github/ISSUE_TEMPLATE/config.yml (route security)`         | `.github/ISSUE_TEMPLATE/config.yml` (new)            | ~12      | 19, 25           |
| 5 | `sdk-php: tests/Exception/ExceptionTest.php (typed-getter cover)`   | `packages/sdk-php/tests/Exception/ExceptionTest.php` (new) | ~110 | 23, 29           |

All five are **pure additive**, **single-file**, **single-objective**,
and **outside the chronic `packages/api` build-break lane** (worker
memory `project_build_broken.md`). None touch wallet code.

## Per-pick rationale

### 1. `sdk-php: ship per-SDK CONTRIBUTING.md`

After PR #254 (`bf6837e4`) queued `packages/sdk-go/CONTRIBUTING.md`,
**PHP is the only SDK without a per-SDK CONTRIBUTING.md**. Verified
on main:

```
packages/sdk-rust/CONTRIBUTING.md   ✓ exists
packages/sdk-python/CONTRIBUTING.md ✓ exists
packages/sdk-go/CONTRIBUTING.md     queued (PR #254 / bf6837e4)
packages/sdk-php/CONTRIBUTING.md    MISSING
```

The per-SDK file is canonical for language-specific tooling
commands (`composer install`, `vendor/bin/phpunit`, PSR-7/17/18
HTTP-discovery hint, PHP version requirement from
`composer.json`'s `"php": "^8.1"`). Without it, PHP contributors
land in the README and guess the toolchain. Premissa 25 (DevRel +
open SDK > paid marketing — first-touch contributors need a clean
on-ramp) + Premissa 31 (open source: SDKs MIT — contribution path
must be public).

**Anti-scope:** mirror the Rust/Python files' structure (dev
environment, test command, code style, PR checklist). Do NOT add
ext-mbstring / ext-curl gymnastics — the PHP SDK only declares
`ext-json` in composer.json. Do NOT modify `composer.json` or any
source file.

### 2. `security: ship root SECURITY.md (GitHub Security tab)`

GitHub auto-detects `SECURITY.md` at the repo root and renders a
"Report a vulnerability" link inside the **Security** tab — the
canonical surface where researchers expect to find the disclosure
policy. PR #245 (`03cf9a17`) queued `public/.well-known/security.txt`
(RFC 9116 network discovery), but the **GitHub-tab discovery** is a
distinct trust signal. The `03cf9a17` rationale explicitly flagged
SECURITY.md as a "separate later mission":

> SECURITY.md at repo root — overlaps trust-signal-wise with pick #3
> [security.txt]; GitHub already renders `.well-known/security.txt`
> indirectly via the Security tab when present. Pick the
> network-discoverable one first; SECURITY.md is a separate later
> mission.

Premissa 19 mandates a $50k public bug bounty pre-mainnet. Both
discovery surfaces are needed — the `audit/BUG_BOUNTY.md`
in-repo + `security.txt` network + `SECURITY.md` GitHub tab form
the standard triad.

**Anti-scope:** single root file. Point readers to
`audit/BUG_BOUNTY.md` (existing) and the
`public/.well-known/security.txt` (queued). Do NOT duplicate the
policy text — link to the canonical sources. Do NOT add a
`docs/SECURITY/` directory; keep it flat.

### 3. `chore: .github/PULL_REQUEST_TEMPLATE.md`

Verified: `.github/` contains only `workflows/` (no PR template, no
issue templates, no FUNDING.yml). The repo has 250+ merged PRs and
zero template enforcement — PR descriptions are inconsistent,
making auto-merge gates (worker memory `feedback_failed_retry_local_only.md`
mentions auto-retry surface) harder to triage. A minimal template
that captures **wallet-less hard-rule check**, **build-status
attestation**, **test plan**, and **co-author = Veridian Fabric**
gives the auto-merge squad a uniform signal.

Premissa 25 (DevRel + DX) + Premissa 26 (toda mission deve ter PR
aberto no fim).

**Anti-scope:** one file. Single template (GitHub also supports
`PULL_REQUEST_TEMPLATE/` directory for multiple variants — do NOT
go there). Sections: Summary, Wallet-less rule check, Build green,
Test plan, Co-author. Do NOT make any section a hard form gate
(no XML form-field syntax); plain Markdown checklist only — that
keeps mission-author worker behavior unchanged.

### 4. `chore: .github/ISSUE_TEMPLATE/config.yml (route security)`

`.github/ISSUE_TEMPLATE/` directory does not exist on main. Without
a `config.yml`, GitHub falls back to the default "open a blank
issue" path, and there is no surfaced link telling researchers to
**report security issues via the bounty channel, not as a public
issue**. A 12-line `config.yml` with `blank_issues_enabled: false`
+ a `contact_links:` block (one entry pointing at the bug-bounty
flow, one pointing at GitHub Discussions / Discord if/when it
exists) closes the disclosure footgun.

Premissa 19 (bug bounty pre-mainnet) + Premissa 25 (DX).

**Anti-scope:** one file. Do NOT add `bug_report.yml` or
`feature_request.yml` form templates in this PR — those are
separate missions (each is a non-trivial form-field design call,
and PHP / Go / Python / Rust each want different fields).
`config.yml` alone is the auto-merge-safe scope.

### 5. `sdk-php: tests/Exception/ExceptionTest.php (typed-getter cover)`

`packages/sdk-php/src/Exception/` ships three classes:

```
ZettaPayException.php   11 LOC — base class
ApiException.php        29 LOC — adds statusCode, errorCode, requestId, body
NetworkException.php    24 LOC — adds previous + helper getters
```

The existing `tests/ClientTest.php` uses these exceptions inside
HTTP-mock scenarios (20 grep matches), but **the typed getter
contract** (constructor arity, `getStatusCode()` / `getErrorCode()`
/ `getRequestId()` / `getBody()` / `getPrevious()` accessor
correctness, inheritance chain `extends \RuntimeException` →
`ZettaPayException` → `ApiException`) is **never asserted in
isolation**. A future refactor that drops a getter or breaks the
inheritance chain would slip past the integration-style tests.

This mirrors how `packages/sdk-python/zettapay/types.py` was
locked down by the dedicated `tests/test_types.py` queued in PR
#254 — same shape for PHP's exception module.

Premissa 23 (SDK-first multi-language parity) + Premissa 29
(coverage > 70% on critical paths — typed errors are the
consumer-facing contract).

**Anti-scope:** one new test file at
`packages/sdk-php/tests/Exception/ExceptionTest.php` (under
`tests/Exception/` matching the source layout). Use PHPUnit 10.5
(already in `require-dev`). Test cases:

- Constructor accepts message + 4 optional fields, defaults to null.
- Each getter returns the constructor value verbatim (typed).
- `NetworkException` retains the `previous` parameter.
- Inheritance assertions:
  `assertInstanceOf(\RuntimeException::class, $e)` +
  `assertInstanceOf(ZettaPayException::class, $apiE)` +
  `assertInstanceOf(ZettaPayException::class, $netE)`.
- One test that asserts `getBody()` returns an array (or null) and
  not a string — that contract matters for downstream JSON
  decoding.

Do NOT touch any `src/Exception/*.php` file. Do NOT add
`Mockery` / `Prophecy` deps (PHPUnit's stock asserts cover this).

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not**
chosen because they fail one or more of {single-file,
single-objective, auto-mergeable, non-controversial, outside
chronic-broken lane}:

- **`.github/FUNDING.yml`** — bikeshed-prone (which sponsor target?
  GitHub Sponsors vs Open Collective vs custom URL). The default
  GitHub behavior without the file is to render no sponsor button,
  which is benign. Leave as a strategic call.
- **`CODE_OF_CONDUCT.md` at root** — Contributor Covenant 2.1 is
  the de-facto default, but enforcement contact + reporting flow
  needs a human ops decision. Not auto-merge scope.
- **`CHANGELOG.md` at root** — generation policy (manual /
  release-please / conventional-commits) requires a release-ops
  decision. The repo already has tagged GitHub Releases; a
  Markdown changelog needs strategy first.
- **`.github/ISSUE_TEMPLATE/bug_report.yml`** — form-field design
  (severity dropdown, repro steps, SDK selector) is non-trivial
  and not the same shape across the five SDKs. Defer until each
  SDK's owner is known.
- **`packages/sdk-php/tests/ConfigTest.php`** — `ClientConfig` is
  68 LOC of mostly typed property accessors; PHPUnit's reflection
  asserts would over-test simple data class. Skip until property
  drift becomes a real risk.
- **`packages/sdk-go/.gitignore`** — Go's stock toolchain handles
  `vendor/` + build artefacts via `go.sum` + `.golangci.yml`;
  adding a `.gitignore` is bikeshed.
- **`CODEOWNERS`** — needs a human ops decision (per-package
  ownership map). Not auto-merge.
- **Root-level `.editorconfig`** — queued in PR #252
  (`a82d92db`). Already covered.
- **`packages/sdk-rust/.gitignore`** — Cargo handles
  `/target/` + `Cargo.lock` (for libs); adding overrides is
  bikeshed.
- **`api/_lib/base58.ts` test file** — `api/` has no vitest
  runner wired (rejected in PR #245 / `03cf9a17`). Still no
  test harness; same blocker.
- **`packages/api` chronic build break** — multi-file structural
  fix in chronic-broken compile lane (worker memory).
- **Zombie sentinel chains (Z29.4 / Z19.2 / Z32 / etc.)** —
  orchestrator-side UUID stickiness, not code missions.

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"`
against the diff this PR introduces returns **only documentary
references** (this rationale doc + SQL comments referencing the
HARD rule for downstream missions). The five queued missions
themselves are:

- CONTRIBUTING.md (markdown, no code)
- SECURITY.md (markdown, no code)
- PR template (markdown, no code)
- ISSUE_TEMPLATE/config.yml (YAML, no code)
- PHP exception test (PHPUnit asserts on typed PHP classes — no
  wallet code path)

None call `connect()` or import wallet-adapter UI.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`).
`npm run build` state on this branch is identical to `main` — the
chronic `packages/api` TS1xxx break (worker memory
`project_build_broken.md`) is unchanged; this PR cannot introduce
or repair it.

## Zombie sanity

Cross-referenced the last 50 merged PRs (#194..#256) + the rolling
sentinel log (worker memory `project_zombie_sentinel_log.md`) +
the eight prior refill SQL companions (`fba46358`, `69cdcbce`,
`4f79ec06`, `03cf9a17`, `1986ee3d`, `a82d92db`, `9db4cb78`,
`bf6837e4`). **None of the 5 mission names** in this refill
collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into
`fabric_squad_missions` + `fabric_audit_journal`. The Supabase
MCP is not granted to mission workers (worker memory
`feedback_supabase_mcp_unavailable.md`); the SQL companion file
`docs/discovery/d5806497-backlog-refill.sql` is the canonical
payload. **Orchestrator (or human operator with service-role
key) applies it on merge.** All statements are wrapped in a
single `BEGIN/COMMIT` so partial application is impossible.
