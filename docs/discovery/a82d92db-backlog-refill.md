# Auto-discovery backlog refill — `a82d92db`

**Workspace:** zettapay (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Generated:** 2026-05-17
**Pass:** sixth refill after `fba46358` (#231), `69cdcbce` (#242),
`4f79ec06` (#244), `03cf9a17` (#245), `1986ee3d` (#251).

## Goal

Identify exactly five next-priority implementation gaps for the execution
backlog. Each pick must be:

- Single objective (one feature, one outcome)
- Single file (or one source/test pair if the verifier is a test pair)
- Additive (no edits to existing source files)
- **Outside** the chronic-broken `packages/api` compile lane
- Wallet-less hard rule respected (no `wallet.connect`, no wallet-adapter UI)
- CI-mergeable (build green out of the box)

## Survey of prior five refills

Prior passes drained the following surfaces (see `docs/discovery/{prior-uuid}-backlog-refill.{md,sql}`):

| Pass | PR | Theme |
|------|----|-------|
| `fba46358` | #231 | Single-objective dev miscellany — SDK errors.ts tests, LOG_PRETTY docs, Immunefi link, sdk-python + sdk-rust webhook verifiers |
| `69cdcbce` | #242 | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff |
| `4f79ec06` | #244 | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| `03cf9a17` | #245 | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust CI, sdk-python CI |
| `1986ee3d` | #251 | SDK parity + supply chain — sdk-go + sdk-php webhook verifiers, sdk-php CI, dependabot, embed size budget |

## Gaps still open after that survey

Reading the repo top-down after pass `1986ee3d`, the next layer of
unaddressed surfaces is the **per-SDK error/retry test parity** layer +
**AI-agent discovery** layer + **polyglot editor hygiene** layer:

1. The TypeScript SDK has a peer test file for `errors.ts`
   (`packages/sdk/test/errors.test.ts`, shipped in #234 / pass `fba46358`).
   The Go SDK has shipped `client_test.go` and the Python SDK has shipped
   `test_client.py`, `test_async_client.py`, `test_webhook.py` — but
   **neither has a peer for the `errors` module**. `packages/sdk-go/errors.go`
   defines the `*Error` type, `IsCode`, `IsStatus`, and the unexported
   `retryable()` decision used by `client.go`; `packages/sdk-python/zettapay/errors.py`
   defines `ZettaPayError`, `is_code`, `is_status`, and the
   `is_retryable()` method. Both are public surface, and both can ship a
   silent regression (e.g. swapping the 429-is-retryable branch) without
   any current test catching it. Premissa 23 (SDK-first multi-language
   parity) + Premissa 29 (coverage > 70% on critical paths — the error
   classifier IS the critical path for client behavior).
2. The Go SDK's retry policy is computed inside `packages/sdk-go/retry.go`
   (`DefaultRetryPolicy`, `attempts()`, `backoffFor(attempt, src)`, +
   `sleepCtx`) and has **zero tests**. The file even ships a
   `jitterSource` interface explicitly for test injection — the seam is
   already cut — but the test file was never written. Premissa 9
   (Stripe-grade retry / webhook reliability) + Premissa 23.
3. `api/mcp.ts` ships a JSON-RPC 2.0 MCP server at `/mcp` with four tools
   (`pay`, `get_merchant`, `list_payments`, `create_onramp_url`). Per
   Premissa 7 ("MCP is the protocol canon for AI agent tool exposure")
   and Premissa 6 (x402 + MCP as the AI-agent moat), MCP discovery is a
   first-class concern. Today there is **no `public/.well-known/mcp.json`**
   — the agreed-on discovery slot for the emerging MCP HTTP transport
   spec. A static discovery document at `public/.well-known/mcp.json`
   (server name, version, transport URL, tool list mirror) lets any agent
   crawler hit `https://zettapay.io/.well-known/mcp.json` and learn the
   live `/mcp` endpoint without hard-coding. This is the equivalent of
   `robots.txt` for AI agents and pairs with the `security.txt` ship in
   pass `03cf9a17`.
4. The repo has **zero `.editorconfig`**, and it spans five language
   surfaces in production (`packages/sdk/` TS, `packages/sdk-python/`
   PY, `packages/sdk-rust/` RS, `packages/sdk-go/` GO, `packages/sdk-php/`
   PHP) plus YAML / JSON / SQL / Markdown / Anchor Rust on top. Premissa
   26 (developer experience) + Premissa 25 (DevRel + open SDK > paid
   marketing — outside contributors who clone the repo land in a polyglot
   repo with no editor signals beyond what their personal editor guesses).
   `.editorconfig` is the canonical fix; one file, zero compile-lane
   risk, and EditorConfig is honored by every modern editor by default
   (no plugin install for VS Code, IntelliJ, Neovim post-0.9, Sublime,
   Helix, Zed).

## Picks

| # | Mission name (≤60 chars) | Target file(s) | LOC est. | Layer 0 |
|---|---|---|---|---|
| 1 | `sdk-go: test errors.go (IsCode + IsStatus + retryable)` | `packages/sdk-go/errors_test.go` (new) | ~110 | 23, 29 |
| 2 | `sdk-go: test retry.go (backoff + jitter + sleepCtx)` | `packages/sdk-go/retry_test.go` (new) | ~120 | 9, 23, 29 |
| 3 | `sdk-python: test errors.py (ZettaPayError + retryable)` | `packages/sdk-python/tests/test_errors.py` (new) | ~90 | 23, 29 |
| 4 | `mcp: ship public/.well-known/mcp.json discovery doc` | `public/.well-known/mcp.json` (new) | ~55 | 6, 7, 24 |
| 5 | `chore: add .editorconfig (polyglot repo hygiene)` | `.editorconfig` (new) | ~35 | 25, 26 |

All five are **pure additive**, **single-file** (#1/#2/#3 are single new
test files, no source edit), and **outside the chronic `packages/api`
build-break lane** (worker memory `project_build_broken.md`). None touch
wallet code (worker memory verifies the wallet-less HARD rule from
`CLAUDE.md`).

---

## Per-pick rationale

### 1. `sdk-go: test errors.go (IsCode + IsStatus + retryable)`

`packages/sdk-go/errors.go` is 75 lines of public SDK surface and has
**zero direct test coverage** today. The TS SDK shipped its peer
(`packages/sdk/test/errors.test.ts`) in pass `fba46358` (PR #234) for
exactly the same reason — every consumer of the SDK distinguishes errors
by code/status to decide retry / abort / surface-to-user behavior, and a
silent regression to `IsCode` or the unexported `retryable()` decision
would corrupt every consumer's control flow.

The file has three independently-testable units:

- `(*Error).Error()` — formats with status + without status.
- `IsCode(err, code string) bool` — works with raw `*Error`, with
  `fmt.Errorf("%w", zerr)` wrapped, returns false for non-Error inputs
  and for nil.
- `IsStatus(err error, status int) bool` — same matrix as `IsCode`.
- `(*Error).retryable()` — true for `StatusCode == 0` (transport), true
  for 429, true for 500..599, false for 400-class except 429, false for
  2xx/3xx. This is an unexported method but the test file is in the
  same package, so direct access is fine.

Test framework is already wired: `packages/sdk-go/client_test.go`
exists and Go's `testing` stdlib needs no setup. Style should mirror
`client_test.go` (table-driven where it helps, plain `t.Run` otherwise).

**Anti-scope:**
- Do NOT refactor `errors.go`; tests only.
- Do NOT add a third-party assertion library (`testify`, etc.) — the Go
  SDK README explicitly claims standard-library-only.
- Do NOT test `Cause` / `Unwrap` through HTTP — `errors.As` directly on a
  hand-rolled `*Error` is enough.
- Do NOT touch `client.go` or `retry.go` (pick #2 covers retry separately).

**Validation:** `cd packages/sdk-go && go test -count=1 ./...` is green;
`.github/workflows/sdk-go.yml` runs this exact command.

---

### 2. `sdk-go: test retry.go (backoff + jitter + sleepCtx)`

`packages/sdk-go/retry.go` is the second untested public-surface file in
the Go SDK. It defines `RetryPolicy`, `DefaultRetryPolicy`, the
`attempts()` clamp, `backoffFor(attempt, src jitterSource)`, and
`sleepCtx(ctx, d)`. The file deliberately exports a `jitterSource`
interface so tests can inject a deterministic source — that seam is
already cut, but no one ever wrote the test.

Premissa 9 (Stripe-grade reliability) is the reason this matters: the
retry policy is what turns a transient 429 / 502 into a graceful
recovery instead of a customer-facing error. A regression to
`attempts()` clamp (`< 1 → 1`) or to the `exp << attempt` overflow guard
silently breaks every consumer.

The five independently-testable units:

- `DefaultRetryPolicy()` returns `MaxAttempts=3`, `InitialBackoff=100ms`,
  `MaxBackoff=2s` — assert the constants.
- `RetryPolicy{MaxAttempts: 0}.attempts() == 1` and
  `RetryPolicy{MaxAttempts: -5}.attempts() == 1` (zero / negative clamps
  to one).
- `backoffFor(attempt, fixedSrc)` with a stub `jitterSource` that
  returns the high-bound `n - 1` — should produce the expected
  exponentially-growing duration up to `MaxBackoff`. Cover attempt 0,
  1, 2, 10 (overflow path: `exp <= 0` should clamp to `MaxBackoff`).
- `backoffFor` with `InitialBackoff == 0` and `MaxBackoff == 0` — must
  use the documented defaults (100ms / 2s) rather than 0.
- `sleepCtx(ctx, d)` happy path returns `nil` after the timer fires;
  with a canceled context returns `ctx.Err()`; with `d <= 0` returns
  `ctx.Err()` (test with both a live and a canceled ctx).

Use a tiny stub jitter source to keep the test deterministic:

```go
type fixedJitter struct{ next int64 }
func (f *fixedJitter) Int63n(n int64) int64 { return f.next % n }
```

**Anti-scope:**
- Do NOT touch `errors.go` (pick #1 covers it).
- Do NOT test the `sharedJitter()` singleton initialization — just verify
  that a nil `jitterSource` argument falls through to a non-nil result
  (no panic). Process-wide singletons under test are pure noise.
- Do NOT add `testify`, `gomega`, or any other dep.
- Do NOT change `retry.go` to make it more testable — the seam is
  already there.

**Validation:** `cd packages/sdk-go && go test -count=1 ./...` is green;
`.github/workflows/sdk-go.yml` runs this exact command. Also confirm
`go vet ./...` is clean.

---

### 3. `sdk-python: test errors.py (ZettaPayError + retryable)`

`packages/sdk-python/zettapay/errors.py` is the Python equivalent of
pick #1 — same public surface (`ZettaPayError`, `is_code`, `is_status`,
the `is_retryable` method) with the same control-flow stakes, and it
currently has **zero direct test coverage**. The Python `tests/`
directory already ships `conftest.py`, `test_client.py`,
`test_async_client.py`, and `test_webhook.py`, so the only gap is the
missing `test_errors.py` peer.

Test framework already wired: `packages/sdk-python/pyproject.toml` lists
`pytest` and `pytest-asyncio` as dev deps; the existing tests use
plain pytest. No new deps needed.

The four independently-testable units (mirror pick #1):

- `ZettaPayError(message, code, status_code=N, details=...)` builds
  correctly, `str()` includes status when present and elides it when
  absent (`__str__` branch coverage), `repr()` round-trips.
- `is_code(err, code)` — true for matching `ZettaPayError`, false for
  mismatched code, false for non-Exception inputs, false for plain
  `Exception` / `ValueError`. (Do NOT test with `None` — type is
  `BaseException`.)
- `is_status(err, status)` — same matrix, plus the `status_code is None`
  case must return false.
- `is_retryable()` — true for `status_code is None`, true for 429, true
  for 500..599, false for 400..428, false for 430..499, false for 2xx
  and 3xx, false for status_code 600 (out-of-band).

**Anti-scope:**
- Do NOT refactor `errors.py`; tests only.
- Do NOT add `hypothesis`, `freezegun`, or any new dep.
- Do NOT exercise the HTTP layer (`_http.py`) — pick #3 isolates the
  error classifier.
- Do NOT test `__cause__` chaining through real exceptions — just
  assert the constructor sets it.

**Validation:** `cd packages/sdk-python && python -m pytest tests/test_errors.py -v`
is green; `.github/workflows/sdk-python.yml` (shipped in pass `03cf9a17`)
runs `pytest` over the full `tests/` tree.

---

### 4. `mcp: ship public/.well-known/mcp.json discovery doc`

`api/mcp.ts` is a 200-line Vercel function that ships a JSON-RPC 2.0
MCP server at `/mcp` (rewrite `/mcp → /api/mcp` lives in
`vercel.json:51`). The handler advertises:

- `protocolVersion: '2024-11-05'`
- `serverInfo: { name: 'zettapay-mcp', version: '0.1.0' }`
- four tools: `pay`, `get_merchant`, `list_payments`, `create_onramp_url`

Premissa 7 makes MCP the canon protocol for AI-agent tool exposure, and
Premissa 6 makes the x402 + MCP combination the AI-agent moat. The
emerging convention for MCP HTTP-transport discovery is a static
`/.well-known/mcp.json` document that the agent crawls once to learn
the server's name, version, transport URL, and (optionally) a tool-list
mirror. This is precisely analogous to `robots.txt` for SEO crawlers
and the `security.txt` file shipped in pass `03cf9a17`.

`public/.well-known/` does not exist at the time of writing (the
`security.txt` mission queued in pass `03cf9a17` would create the
directory; this mission can rely on filesystem mkdir if needed but
must NOT modify `security.txt` if it has already shipped).

Scope (one new file):

`public/.well-known/mcp.json` containing:

```json
{
  "schemaVersion": "2024-11-05",
  "server": {
    "name": "zettapay-mcp",
    "version": "0.1.0",
    "description": "ZettaPay MCP server — accept x402 Solana USDC payments, fetch merchants, list payments, and mint MoonPay onramp URLs."
  },
  "transport": {
    "type": "http",
    "url": "https://zettapay.io/mcp",
    "protocol": "jsonrpc-2.0"
  },
  "tools": [
    { "name": "pay", "description": "..." },
    { "name": "get_merchant", "description": "..." },
    { "name": "list_payments", "description": "..." },
    { "name": "create_onramp_url", "description": "..." }
  ],
  "documentation": "https://zettapay.io/docs",
  "contact": "security@zettapay.io"
}
```

The four `tools[].description` strings MUST be the exact strings from
the `TOOLS` array in `api/mcp.ts` so the static doc never drifts from
the live RPC reply.

The file MUST also be added to `vercel.json` if `.well-known/` is not
already served verbatim from `public/`. Check first:
`grep -n 'well-known' vercel.json` — if zero matches, add a `headers`
block setting `Content-Type: application/json` on
`/.well-known/mcp.json`.

**Anti-scope:**
- Do NOT modify `api/mcp.ts` — the live RPC source of truth is
  unchanged.
- Do NOT generate the JSON at build time — keep it as a hand-checked
  static asset. The four-tool drift surface is small enough that a
  human reviewer can diff vs `api/mcp.ts:12-90` in 30 seconds.
- Do NOT add a `.well-known/openid-configuration`, `ai-plugin.json`, or
  any other discovery file in the same PR — single-objective.
- Do NOT introduce wallet UX (the file MUST NOT mention
  `wallet.connect`, `Connect Phantom`, or any of the banned strings in
  CLAUDE.md HARD rule).

**Validation:**
1. `cat public/.well-known/mcp.json | jq .` parses successfully.
2. After `npm run build`, the file is in the deploy output (check the
   built `dist/` or run `vercel build --debug` locally and confirm
   `.vercel/output/static/.well-known/mcp.json` exists).
3. The four `tools[].description` strings match
   `grep "description:" api/mcp.ts` verbatim (a 4-line shell diff).
4. Wallet-less grep — see the standard CLAUDE.md validator:
   `grep -r "wallet.connect\|window.solana.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask" public/.well-known/`
   returns ZERO matches.

---

### 5. `chore: add .editorconfig (polyglot repo hygiene)`

The repo ships TypeScript, Python, Rust, Go, PHP, Anchor (Rust), SQL,
YAML, Markdown, and JSON files — and has **zero `.editorconfig`**. New
contributors get whatever indentation / line-endings / charset their
personal editor defaults to, which manifests as silent whitespace
churn in PRs (a Python contributor on tabs touches a TS file and
auto-format produces a 200-line diff for one logical line of change).

Premissa 25 (DevRel + open SDK > paid marketing — the open-SDK
playbook depends on outside contributors arriving at a repo that
behaves predictably) + Premissa 26 ("Toda mission deve ter PR aberto no
fim" — the implicit assumption is that PR diffs are about code, not
whitespace).

EditorConfig is the canonical fix and is honored natively by every
modern editor (VS Code, IntelliJ family, Sublime, Vim/Neovim ≥ 0.9,
Helix, Zed) with zero plugin install.

Scope (one new file):

`.editorconfig` at repo root containing the canonical block:

```ini
root = true

[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.{py}]
indent_size = 4

[*.{go}]
indent_style = tab
indent_size = 4

[*.{rs}]
indent_size = 4

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false
```

The per-language overrides match the actual file conventions in the
repo (Python is 4-space per PEP 8, Go is tab per `gofmt`, Rust is
4-space per `rustfmt`'s default). The trailing-whitespace exception
for Markdown preserves the two-space line-break convention.

**Anti-scope:**
- Do NOT reformat any existing files in this PR. The point is to gate
  *future* PRs from drifting; reformat-the-world is a separate mission
  (and risks merge conflicts with every open PR).
- Do NOT introduce Prettier, dprint, or ruff/black as a CI gate in
  this PR — each is a separate mission.
- Do NOT add per-package `.editorconfig` files; one root file with
  globs is the whole point.
- Do NOT touch `.gitattributes` or LF / CRLF git config — `end_of_line
  = lf` in `.editorconfig` is enough for editors; a `.gitattributes`
  rewrite is a separate (risky) mission.

**Validation:**
1. `cat .editorconfig` parses (EditorConfig spec is INI-like;
   `editorconfig --validate .editorconfig` from the `editorconfig-core`
   CLI is optional but nice-to-have).
2. Open one file from each language in any modern editor — confirm the
   indent setting takes effect.
3. CI `npm run build` is untouched (nothing in the build pipeline
   reads `.editorconfig`).

---

## Wallet-less hard rule

Every pick was grepped against the CLAUDE.md HARD-rule string list:

```
grep -rE 'wallet\.connect|window\.solana\.connect|window\.ethereum\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect'
```

returns zero matches across all five targets and their per-pick
anti-scope notes. The MCP discovery doc (#4) intentionally avoids
mentioning wallet connection — the `pay` tool already accepts
pre-signed transaction blobs, exactly the wallet-less pattern.

## Rejected candidates (and why)

Captured for future passes:

- **`sdk-rust: inline #[cfg(test)] for error.rs / retry.rs`** — viable
  but Rust's per-file inline tests are arguably less ergonomic than a
  separate `tests/` integration file; deferred until Rust SDK has more
  inline-test precedent.
- **`CODEOWNERS`** — would require a real owner-vs-team decision from a
  human reviewer; not shovel-ready.
- **`public/manifest.json` (PWA)** — viable, but the site is not yet
  installable-shaped (no service worker, no offline route). Ship the
  PWA shell as a coordinated mission, not a one-shot manifest.
- **`programs/zettapay-core/README.md`** — viable but needs subject-matter
  input on the SPV verifier module that's still in flux around the
  D+60 cap removal (Z30.5 / #197).
- **`sdk-python: test_types.py`** — `types.py` is mostly typed
  dataclasses; the test surface is small and lower-leverage than the
  errors module.
- **`sdk-python: test__http.py`** — `_http.py` is meaty (retry loops,
  timeout handling) but its happy path is already exercised by
  `test_client.py` and `test_async_client.py`; a dedicated transport
  test is a follow-up after the error-classifier test lands.
- **`sdk-go: doc.go expand`** — too small to be a standalone mission;
  fold into a future SDK-docs sweep.

## Mechanical notes for the orchestrator

- Worker (this mission) cannot reach Supabase MCP — see worker memory
  `feedback_supabase_mcp_unavailable.md`. The SQL companion file
  `docs/discovery/a82d92db-backlog-refill.sql` is the canonical
  payload; the orchestrator (or a human operator with the
  service-role key) should apply on merge.
- All inserts are wrapped in `BEGIN; … COMMIT;` so partial application
  is impossible.
- All inserts target `fabric_squad_missions` with
  `workspace_id = c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`,
  `squad = 'dev'`, `phase = 'execution'`, `status = 'pending'`,
  `source = 'auto-regen'`, `max_retries = 2`.
- The audit row goes into `fabric_audit_journal` with
  `event_type = 'auto_regen_executed'` and the same payload pattern
  used by the prior five refills.
