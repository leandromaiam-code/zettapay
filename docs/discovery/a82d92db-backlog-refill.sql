-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: a82d92db
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/a82d92db-backlog-refill.md
-- All 5 picks are single-objective, additive, and outside the chronic-broken
-- packages/api compile lane. None touch wallet code.
--
-- Themes covered: per-SDK error/retry test parity (Go x2 + Python x1),
-- AI-agent MCP discovery doc, polyglot editor hygiene.
--
-- Prior five refills (fba46358 #231, 69cdcbce #242, 4f79ec06 #244,
-- 03cf9a17 #245, 1986ee3d #251) drained the single-objective /
-- site-launch / SDK + Vercel API / test-CI-DX / SDK-parity-supply-chain
-- queues. This pass targets the next-layer surfaces.
--
-- The mission worker could not reach Supabase MCP directly (see worker memory
-- feedback_supabase_mcp_unavailable.md); these statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-go: test errors.go — parity with TS SDK errors.test.ts (#234)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-go: test errors.go (IsCode + IsStatus + retryable)',
$$Add a peer test file for the Go SDK error classifier so the public Error
type, IsCode, IsStatus, and the unexported retryable() decision cannot
silently regress. The TypeScript SDK shipped its peer
(packages/sdk/test/errors.test.ts) in PR #234; the Go SDK ships
client_test.go but no errors_test.go. Premissa 23 (SDK-first multi-language
parity) + Premissa 29 (coverage > 70% on critical paths — the error
classifier IS the critical path for every consumer's retry / abort /
surface-to-user decision).

Scope (1 new file, ~110 LOC):

Create packages/sdk-go/errors_test.go in package `zettapay` (same package
as errors.go, so the unexported retryable() method is in scope).

Cover the four independently-testable units in errors.go:

1. (*Error).Error() formatting:
   - With StatusCode > 0: returns "zettapay: <message> (code=<code>, status=<status>)"
   - With StatusCode == 0: returns "zettapay: <message> (code=<code>)"
   - Table-driven test with at least 3 rows covering both branches.

2. IsCode(err, code string) bool:
   - True for a raw *Error with matching code.
   - True for a *Error wrapped via fmt.Errorf("wrapped: %w", zerr) — must
     unwrap via errors.As.
   - False for a *Error with mismatched code.
   - False for a non-Error input (errors.New("plain")).
   - False for a typed-nil *Error wrapped in error interface (defensive).

3. IsStatus(err error, status int) bool:
   - Same matrix as IsCode but on StatusCode.
   - Cover the wrapped-via-%w case.

4. (*Error).retryable() (unexported — same-package test):
   - True for StatusCode == 0 (transport failure).
   - True for StatusCode == 429.
   - True for StatusCode in {500, 503, 599}.
   - False for StatusCode in {200, 301, 400, 401, 403, 404, 422}.
   - Table-driven.

Style mirrors packages/sdk-go/client_test.go (existing in-tree precedent).

Anti-scope:
- Do NOT refactor errors.go; tests only.
- Do NOT add a third-party assertion library (testify, gocheck, etc.) —
  the Go SDK README explicitly claims standard-library-only.
- Do NOT exercise Cause / Unwrap through real HTTP — synthesize *Error
  values directly.
- Do NOT touch client.go or retry.go (a separate mission covers retry).
- Do NOT add a benchmark — coverage is enough.

Validation:
- `cd packages/sdk-go && go test -count=1 -run TestError ./...` is green.
- `cd packages/sdk-go && go test -count=1 ./...` (full suite) is green.
- `cd packages/sdk-go && go vet ./...` is clean.
- .github/workflows/sdk-go.yml already runs `go test ./...` — the new
  file participates automatically.
- grep -rE 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect' packages/sdk-go/errors_test.go
  returns zero matches (wallet-less HARD rule).

Conflicts:
- None — confirmed by `ls packages/sdk-go/*_test.go` returning only
  client_test.go on main HEAD (commit 6a3c9ce). No open PR targets
  packages/sdk-go/errors_test.go (gh pr list --state open --search
  errors_test).$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 2. sdk-go: test retry.go — backoff + jitter + sleepCtx
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-go: test retry.go (backoff + jitter + sleepCtx)',
$$Add a peer test file for packages/sdk-go/retry.go so the RetryPolicy
defaults, attempts() clamp, backoffFor() exponential growth with full
jitter (and overflow clamp), and sleepCtx() context-cancel behavior
cannot silently regress. The file already exports a jitterSource
interface explicitly for test injection — the seam is cut, the test was
never written. Premissa 9 (Stripe-grade retry / webhook reliability) +
Premissa 23 (SDK-first multi-language parity) + Premissa 29 (coverage).

Scope (1 new file, ~120 LOC):

Create packages/sdk-go/retry_test.go in package `zettapay` (same package
as retry.go).

Use a deterministic fake jitter source at the top of the file:

```go
type fixedJitter struct{ val int64 }
func (f *fixedJitter) Int63n(n int64) int64 {
    if n <= 0 { return 0 }
    return f.val % n
}
```

Cover the five independently-testable units:

1. DefaultRetryPolicy() returns the documented constants:
   - MaxAttempts == 3
   - InitialBackoff == 100 * time.Millisecond
   - MaxBackoff == 2 * time.Second

2. (RetryPolicy).attempts() clamp:
   - {MaxAttempts: 0}.attempts() == 1
   - {MaxAttempts: -5}.attempts() == 1
   - {MaxAttempts: 1}.attempts() == 1
   - {MaxAttempts: 3}.attempts() == 3
   - {MaxAttempts: 99}.attempts() == 99

3. (RetryPolicy).backoffFor(attempt, src) with a fixedJitter returning
   the high bound (n-1):
   - DefaultRetryPolicy().backoffFor(0, &fixedJitter{val: math.MaxInt64})
     produces backoff strictly less than InitialBackoff (100ms) — proves
     base case.
   - .backoffFor(1, …) produces a duration <= 200ms (exp = base << 1).
   - .backoffFor(2, …) produces a duration <= 400ms.
   - .backoffFor(10, …) produces a duration <= MaxBackoff (overflow
     path: exp <= 0 || exp > max → exp = max). This proves the
     overflow clamp.
   - With InitialBackoff == 0 and MaxBackoff == 0, backoffFor uses the
     documented fallback defaults (100ms / 2s) rather than 0 — assert
     that the returned duration is positive and bounded by 2s.
   - With a nil jitterSource argument, backoffFor must NOT panic
     (falls through to sharedJitter()); assert duration is non-negative
     and bounded.

4. sleepCtx(ctx, d) behavior:
   - Live ctx + small d (e.g. 10ms) returns nil after the timer fires.
   - Pre-canceled ctx + nonzero d returns ctx.Err() promptly (within a
     small grace, e.g. assert returned within 50ms via a wall-clock
     check).
   - Live ctx + d == 0 returns ctx.Err() (nil for an uncanceled ctx).
   - Live ctx + d < 0 returns ctx.Err() (same path as d == 0).

5. Sanity: t.Parallel() is safe to use on the table-driven sub-tests
   (no shared state in fixedJitter instances).

Style mirrors packages/sdk-go/client_test.go (existing in-tree
precedent). Use `import "testing"` + `import "time"` + `import "context"`
+ `import "math"` + `import "errors"` only — standard library.

Anti-scope:
- Do NOT touch errors.go (separate mission).
- Do NOT modify retry.go to make it more testable — the seam is already
  there (jitterSource interface).
- Do NOT test the sharedJitter() singleton's once-initialization — just
  verify that a nil jitterSource argument falls through to a non-nil
  result without panicking. Process-wide singletons under test are pure
  noise.
- Do NOT add testify, gomega, or any other third-party assertion lib.
- Do NOT add a benchmark for backoffFor (coverage is enough; benchmarks
  are a separate mission).
- Do NOT exercise the full client.go retry loop — that's an integration
  concern. This mission isolates retry.go behavior.

Validation:
- `cd packages/sdk-go && go test -count=1 -run TestRetry ./...` is green.
- `cd packages/sdk-go && go test -count=1 -race ./...` is green.
- `cd packages/sdk-go && go vet ./...` is clean.
- .github/workflows/sdk-go.yml runs the suite automatically.
- grep -rE 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect' packages/sdk-go/retry_test.go
  returns zero matches.

Conflicts:
- None — confirmed by `ls packages/sdk-go/*_test.go` returning only
  client_test.go on main HEAD (commit 6a3c9ce). No open PR targets
  packages/sdk-go/retry_test.go.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 3. sdk-python: test errors.py — ZettaPayError + retryable parity
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-python: test errors.py (ZettaPayError + retryable)',
$$Add a peer test file for the Python SDK error classifier so
ZettaPayError, is_code(), is_status(), and the is_retryable() method
cannot silently regress. The TS SDK shipped its peer in #234 (pass
fba46358); the Go SDK gets its peer in this same backlog (pick #1).
Python is the language parity gap. Premissa 23 (SDK-first multi-language
parity) + Premissa 29 (coverage > 70% on critical paths).

Scope (1 new file, ~90 LOC):

Create packages/sdk-python/tests/test_errors.py.

Use pytest (already a dev dep in pyproject.toml). Import path:
`from zettapay.errors import ZettaPayError, is_code, is_status`.

Cover the four independently-testable units:

1. ZettaPayError construction + __str__ + __repr__:
   - With status_code=N: str() == "zettapay: <message> (code=<code>, status=<N>)"
   - With status_code=None: str() == "zettapay: <message> (code=<code>)" (no
     "status=" substring — assert via "status=" not in str(err)).
   - __repr__() returns a string containing "ZettaPayError(", the message,
     the code, and the status_code (round-trip-readable form).
   - Constructor accepts and stores details=any (e.g. a dict or a list
     of validation errors) without coercion.
   - Constructor accepts cause=BaseException and sets __cause__ for
     `raise X from Y`-style chaining.

2. is_code(err, code) -> bool:
   - True for a ZettaPayError with matching code.
   - False for a ZettaPayError with mismatched code.
   - False for a plain Exception / ValueError / RuntimeError.
   - False for a ZettaPayError raised then caught (use a try/except to
     prove identity is preserved, not just construction).

3. is_status(err, status) -> bool:
   - Same matrix as is_code.
   - The status_code is None case must return False for any int.

4. is_retryable() method on ZettaPayError:
   - True for status_code is None (transport failure).
   - True for status_code == 429.
   - True for status_code in {500, 503, 599}.
   - False for status_code in {200, 301, 400, 401, 403, 404, 422, 428,
     430, 499, 600}.
   - Use pytest.mark.parametrize for the 5xx and 4xx matrices.

Style mirrors packages/sdk-python/tests/test_webhook.py and
test_client.py (existing in-tree precedent). Use plain pytest — no
pytest-asyncio needed (errors.py has no async surface).

Anti-scope:
- Do NOT refactor errors.py; tests only.
- Do NOT add hypothesis, freezegun, or any new dep.
- Do NOT exercise the HTTP transport (_http.py) — this mission isolates
  the error classifier. The HTTP layer is a separate (already-deferred)
  mission.
- Do NOT test __cause__ chaining through real raised exceptions — just
  assert the constructor sets it on the instance.
- Do NOT add a conftest.py fixture for ZettaPayError — direct
  construction is clearer than a fixture for a one-line value.

Validation:
- `cd packages/sdk-python && python -m pytest tests/test_errors.py -v` is
  green.
- `cd packages/sdk-python && python -m pytest tests/ -v` (full suite) is
  green.
- .github/workflows/sdk-python.yml (shipped in pass 03cf9a17) runs
  pytest over the full tests/ tree.
- grep -rE 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect' packages/sdk-python/tests/test_errors.py
  returns zero matches.

Conflicts:
- None — confirmed by `ls packages/sdk-python/tests/` returning only
  conftest.py, test_async_client.py, test_client.py, test_webhook.py on
  main HEAD (commit 6a3c9ce). No open PR targets
  packages/sdk-python/tests/test_errors.py.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 4. mcp: ship public/.well-known/mcp.json discovery doc
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'mcp: ship public/.well-known/mcp.json discovery doc',
$$Ship a static MCP discovery document at public/.well-known/mcp.json so
AI agents (Claude, GPT, Gemini, Mariner, Operator) can discover the
ZettaPay MCP server's name, version, transport URL, and tool list
without hard-coding /mcp. This is the AI-agent equivalent of robots.txt
for crawlers and security.txt for vuln reporters (security.txt was
queued in pass 03cf9a17). Premissa 7 (MCP is the protocol canon for AI
agent tool exposure) + Premissa 6 (x402 + MCP combination as the
AI-agent moat) + Premissa 24 (docs/trust signals).

Scope (1 new file, ~55 LOC of JSON):

Create public/.well-known/mcp.json.

Content schema (validate parses with `jq .`):

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
    {
      "name": "pay",
      "description": "<COPY VERBATIM from TOOLS[0].description in api/mcp.ts>"
    },
    {
      "name": "get_merchant",
      "description": "<COPY VERBATIM from TOOLS[1].description in api/mcp.ts>"
    },
    {
      "name": "list_payments",
      "description": "<COPY VERBATIM from TOOLS[2].description in api/mcp.ts>"
    },
    {
      "name": "create_onramp_url",
      "description": "<COPY VERBATIM from TOOLS[3].description in api/mcp.ts>"
    }
  ],
  "documentation": "https://zettapay.io/docs",
  "contact": "security@zettapay.io"
}

The four tools[].description strings MUST be exact copies of the
descriptions in api/mcp.ts (constants PROTOCOL_VERSION, SERVER_NAME,
SERVER_VERSION, and the TOOLS array at api/mcp.ts:12-90). This is to
guarantee the static doc never drifts from the live RPC reply.

The server.name and server.version MUST match the SERVER_NAME and
SERVER_VERSION constants in api/mcp.ts:4-5 exactly.

After writing the file, verify it is served by Vercel:

1. grep -n 'well-known' vercel.json — if the file shows no special
   handling, the default `public/` static serving will work (Vercel
   serves public/.well-known/* as /.well-known/* by default). NO
   vercel.json change required in that case.
2. If a Content-Type header override is needed (it should not be —
   Vercel infers application/json from the .json extension), add ONLY
   a Content-Type headers block under the existing `headers` array in
   vercel.json. Do NOT add rewrites.
3. After `npm run build`, confirm `.vercel/output/static/.well-known/mcp.json`
   exists in the build output (or whatever the in-repo build target
   is — adapt to current vercel.json static-build config).

The directory `public/.well-known/` may not yet exist on main HEAD; if
the security.txt mission queued in pass 03cf9a17 (#245 SQL) has not yet
landed, this mission creates the directory. If it has landed, this
mission adds a peer file alongside security.txt — DO NOT modify or
move security.txt.

Anti-scope:
- Do NOT modify api/mcp.ts — the live RPC source of truth is unchanged.
- Do NOT generate the JSON at build time — keep it as a hand-checked
  static asset. The four-tool drift surface is small enough that a
  human reviewer can diff vs api/mcp.ts:12-90 in 30 seconds.
- Do NOT add .well-known/openid-configuration, .well-known/ai-plugin.json,
  or any other discovery file in the same PR — single-objective.
- Do NOT modify or move public/.well-known/security.txt if it has
  already shipped (independent file).
- Do NOT mention any wallet-connect surface in the descriptions. The
  `pay` tool already accepts pre-signed transaction blobs — that's the
  wallet-less pattern in action.

Validation:
1. `cat public/.well-known/mcp.json | jq .` parses successfully and
   round-trips.
2. The four tools[].description strings match
   `node -e "const fs=require('fs'); const s=fs.readFileSync('api/mcp.ts','utf8'); console.log(s)"`
   (or a simple grep "description:" api/mcp.ts) for verbatim equality.
3. The server.name matches SERVER_NAME in api/mcp.ts (zettapay-mcp).
4. The server.version matches SERVER_VERSION in api/mcp.ts (0.1.0).
5. The schemaVersion matches PROTOCOL_VERSION in api/mcp.ts (2024-11-05).
6. `npm run build` is green; the file is in the deploy output.
7. grep -rE 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect' public/.well-known/
   returns zero matches (wallet-less HARD rule).

Conflicts:
- None — confirmed by `ls public/.well-known/ 2>&1` returning "No such
  file or directory" on main HEAD (commit 6a3c9ce). No open PR targets
  public/.well-known/mcp.json.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 5. chore: add .editorconfig (polyglot repo hygiene)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: add .editorconfig (polyglot repo hygiene)',
$$Add a canonical .editorconfig at the repo root so the polyglot
ZettaPay codebase (TypeScript, Python, Rust, Go, PHP, Anchor Rust, SQL,
YAML, Markdown, JSON) has uniform indentation, line-endings, charset,
and trailing-whitespace handling regardless of the contributor's editor.
This eliminates the silent whitespace churn that turns a one-line PR
diff into a 200-line whitespace-noise diff. Premissa 25 (DevRel + open
SDK > paid marketing — outside contributors land in a repo that
behaves predictably) + Premissa 26 (every mission ends in a PR — PR
diffs should be about code, not whitespace).

EditorConfig is honored natively by every modern editor (VS Code,
IntelliJ family, Sublime, Vim/Neovim >= 0.9, Helix, Zed) with zero
plugin install.

Scope (1 new file, ~35 LOC):

Create .editorconfig at the repo root with content (verbatim):

root = true

[*]
end_of_line = lf
insert_final_newline = true
charset = utf-8
trim_trailing_whitespace = true
indent_style = space
indent_size = 2

[*.py]
indent_size = 4

[*.go]
indent_style = tab
indent_size = 4

[*.rs]
indent_size = 4

[Makefile]
indent_style = tab

[*.md]
trim_trailing_whitespace = false

Per-language overrides match the actual conventions in the repo:
- Python is 4-space per PEP 8 (matches existing
  packages/sdk-python/zettapay/*.py).
- Go is tab per `gofmt` (matches existing packages/sdk-go/*.go).
- Rust is 4-space per `rustfmt` default (matches existing
  packages/sdk-rust/src/*.rs and programs/*/src/*.rs).
- Makefile MUST be tab (Make recipe syntax requires literal tabs).
- Markdown trailing-whitespace preserved (the two-space line-break
  convention).

The [*] default of 2-space indent matches the existing TS / JS / JSON
/ YAML convention in packages/sdk/src, public/, api/, .github/, and
all root-level config files.

Anti-scope:
- Do NOT reformat any existing files in this PR. The point is to gate
  *future* PR drift; reformat-the-world is a separate (risky) mission
  that would conflict with every open PR.
- Do NOT introduce Prettier, dprint, ruff, black, gofumpt, or
  rustfmt-as-CI-gate in this PR — each is a separate mission.
- Do NOT add per-package .editorconfig files; one root file with globs
  is the entire point.
- Do NOT touch .gitattributes or git's autocrlf config —
  end_of_line = lf in .editorconfig is sufficient for editors; a
  .gitattributes rewrite is a separate (risky) mission that affects
  the working tree of every existing clone.
- Do NOT mention any tool/IDE/editor by name in commit message or PR
  body beyond "EditorConfig" itself (no Sublime/VS Code/IntelliJ
  marketing-style copy — Premissa 25 brand discipline).

Validation:
1. `cat .editorconfig` parses (EditorConfig spec is INI-like).
2. Optional: if `editorconfig-core` CLI is installed,
   `editorconfig --validate .editorconfig` exits 0.
3. Optional spot-check: open one .ts, one .py, one .go, one .rs file
   in any modern editor — confirm indent setting matches the override.
4. `npm run build` is untouched (nothing in the build pipeline reads
   .editorconfig).
5. `git diff --stat HEAD` shows exactly one file added
   (.editorconfig); no other file changed.
6. grep -rE 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect' .editorconfig
   returns zero matches (wallet-less HARD rule — vacuous for a config
   file but kept for audit-log uniformity).

Conflicts:
- None — confirmed by `ls -la .editorconfig 2>&1` returning "No such
  file or directory" on main HEAD (commit 6a3c9ce). No open PR
  targets .editorconfig.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- Audit row — auto_regen_executed for this pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', 'a82d92db',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/a82d92db-backlog-refill.md',
     'companion_sql', 'docs/discovery/a82d92db-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk-go: test errors.go (IsCode + IsStatus + retryable)',
       'sdk-go: test retry.go (backoff + jitter + sleepCtx)',
       'sdk-python: test errors.py (ZettaPayError + retryable)',
       'mcp: ship public/.well-known/mcp.json discovery doc',
       'chore: add .editorconfig (polyglot repo hygiene)'
     ),
     'themes', jsonb_build_array(
       'per-sdk-error-retry-test-parity',
       'ai-agent-mcp-discovery',
       'polyglot-editor-hygiene'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk-go (additive, std-lib only, gated by sdk-go.yml)',
       'packages/sdk-python (additive, pytest std, gated by sdk-python.yml)',
       'public/.well-known (static asset, no compile)',
       'repo-root (config-only, no compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors of existing source',
       'reformat-the-world sweeps (editorconfig adds gate only, not bulk reformat)',
       'live api/mcp.ts source (mcp.json is a static mirror)'
     ),
     'known_followups', jsonb_build_array(
       'sdk-rust: inline #[cfg(test)] for error.rs + retry.rs (deferred this pass)',
       'sdk-python: tests/test__http.py for the transport layer',
       'sdk-python: tests/test_types.py for the dataclass exports',
       'sdk-go: doc.go expansion (too small to be standalone)',
       'CODEOWNERS (needs human owner/team decision — not shovel-ready)',
       'public/manifest.json PWA shell (needs coordinated service worker / offline route)',
       'programs/zettapay-core/README.md (defer until D+60 cap-removal stabilizes)',
       'Prettier / dprint / ruff / black / gofumpt as CI gates (each its own mission)',
       '.gitattributes LF/CRLF rewrite (separate risky mission — editorconfig is enough today)'
     )
   ));

COMMIT;
