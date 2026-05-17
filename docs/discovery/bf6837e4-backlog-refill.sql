-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: bf6837e4
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/bf6837e4-backlog-refill.md
-- All 5 picks are single-objective, additive, and outside the chronic-broken
-- packages/api compile lane. None touch wallet code.
--
-- Themes covered: PHP quickstart parity (last SDK without one), Go per-SDK
-- CONTRIBUTING.md (last SDK without one), Python types freeze + equality
-- tests, GitHub CodeQL security workflow, repo-root .tool-versions polyglot
-- toolchain lock.
--
-- Prior seven refills (fba46358 #231, 69cdcbce #242, 4f79ec06 #244,
-- 03cf9a17 #245, 1986ee3d #251, a82d92db #252, 9db4cb78 #253) drained the
-- single-objective / site-launch / SDK+Vercel-API / test-CI-DX /
-- SDK-parity-supply-chain / SDK-test+MCP+editorconfig / cross-SDK+HARD-rule
-- queues. This pass attacks the next-layer polyglot gaps.
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-php: examples/quickstart.php — parity with rust + python quickstart
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-php: examples/quickstart.php (parity with rust/python quickstart)',
$$Add an `examples/quickstart.php` runnable program to the PHP SDK so the
README's "Quick start" code block is also an executable artifact. The Rust
SDK ships `packages/sdk-rust/examples/quickstart.rs`; the Python SDK
ships `packages/sdk-python/examples/quickstart.py`; the Go SDK quickstart
is queued in UUID prefix 9db4cb78 (PR #253). PHP is the LAST SDK without
a quickstart example. Premissa 23 (SDK-first multi-language parity) +
Premissa 25 (DevRel + open SDK > paid marketing — first-touch developers
copy the example).

Scope (1 new file, ~120 LOC):

Create packages/sdk-php/examples/quickstart.php as a standalone CLI script
that walks the same happy-path flow the Rust and Python examples walk.
Because the PHP SDK requires Composer autoload, the script must load
vendor/autoload.php relative to the example's location:

  <?php
  declare(strict_types=1);
  require __DIR__ . '/../vendor/autoload.php';

Then read env vars (use getenv() — no third-party config lib):

- ZETTAPAY_BASE_URL (default http://localhost:3000)
- ZETTAPAY_API_KEY (optional; null disables Authorization header)
- ZETTAPAY_SIGNED_TX_BASE64 (optional — skip payment step if absent)

Build a `ZettaPay\Client` via the existing constructor / factory in
packages/sdk-php/src/Client.php. Use the same fixture pubkey / ATA as the
Rust and Python examples so devs migrating between SDKs see identical
output:

- pubkey: 7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT
- USDC ATA: EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK

Flow (each step echo a `-> ...` line for parity with rust/python output):

1. `\$client->health()` — print status + counts.
2. Register a merchant via `\$client->merchants->register(...)` (or
   whatever the resource method is named under
   packages/sdk-php/src/Resource/; introspect to use the actual name —
   the example must compile).
3. `\$client->merchants->get(\$id)` — fetch back.
4. `\$client->merchants->list(['limit' => 5])` — paginated read.
5. `\$client->merchants->update(\$id, ['name' => 'Quickstart Demo'])`.
6. If ZETTAPAY_SIGNED_TX_BASE64 is set, call `\$client->pay(\$tx)` and
   print `\$response->paymentId`; otherwise echo "skipped (no signed tx)".
7. Best-effort cleanup: `\$client->merchants->delete(\$id)` inside
   try/catch (no-op if endpoint missing).

Error handling: wrap each call in try/catch and on a
`\ZettaPay\Exception\ZettaPayException` (or whatever the SDK's typed error
class is — introspect packages/sdk-php/src/Exception/ to use the real
class), echo `"-> error: {\$e->getCode()} {\$e->getMessage()}\n"` and
continue (the script should still exit 0 in --soft mode for CI smoke).

Header doc comment includes run instructions:

  /**
   * ZettaPay PHP SDK — quickstart example.
   *
   * Run locally:
   *   cd packages/sdk-php && composer install && php examples/quickstart.php
   *
   * Against a deployed environment:
   *   ZETTAPAY_BASE_URL=https://api.zettapay.dev \
   *   ZETTAPAY_API_KEY=zp_live_... \
   *   php packages/sdk-php/examples/quickstart.php
   */

Anti-scope:
- Do NOT add a new dependency to composer.json. The example must work
  with the existing PSR-7/17/18 + php-http/discovery stack already
  declared.
- Do NOT introduce a Symfony Console / Laravel binding. Plain PHP CLI
  only.
- Do NOT sign / submit a real Solana transaction in the example —
  the SDK explicitly does not custody keys. Payment step is skipped
  unless the caller injects a pre-signed base64 blob via env.
- Do NOT include any mention of `wallet.connect`, `window.solana`,
  wallet-adapter, or "Connect Phantom / Wallet / MetaMask" —
  wallet-less HARD rule.
- Do NOT add a composer script entry (no `"scripts"` block edit).
- Do NOT change autoload.psr-4 paths in composer.json.

Validation:
1. `cd packages/sdk-php && composer install` (if not already).
2. `php -l examples/quickstart.php` — syntax OK (no parse error).
3. `cd packages/sdk-php && composer validate --strict` — composer.json
   unchanged and still valid.
4. `php examples/quickstart.php` against a local stub (or omit env vars
   to skip API calls — health() will fail fast and the script exits
   non-zero, which is fine for smoke; the LINT step above is the
   real gate).
5. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" packages/sdk-php/examples/quickstart.php`
   returns zero matches.
6. `git diff --stat HEAD` shows exactly one file added:
   packages/sdk-php/examples/quickstart.php.

Conflicts:
- None — confirmed by `ls packages/sdk-php/examples 2>&1` returning
  "No such file or directory" on main HEAD (commit 89b0b90). No open PR
  targets packages/sdk-php/examples/.

References:
- Sibling: packages/sdk-rust/examples/quickstart.rs.
- Sibling: packages/sdk-python/examples/quickstart.py.
- Go quickstart mission (queued in 9db4cb78 PR #253).
- Public surface map: packages/sdk-php/src/Client.php, src/ClientConfig.php,
  src/Resource/*, src/Model/*, src/Exception/*, src/RetryPolicy.php.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 2. sdk-go: per-SDK CONTRIBUTING.md — last SDK without one
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-go: per-SDK CONTRIBUTING.md (mirror sdk-rust + sdk-python)',
$$Add `packages/sdk-go/CONTRIBUTING.md` so Go SDK contributors land in a
documented per-SDK path instead of guessing the toolchain from go.mod.
`packages/sdk-rust/CONTRIBUTING.md` and `packages/sdk-python/CONTRIBUTING.md`
both exist on main; the root CONTRIBUTING.md is queued in UUID prefix
9db4cb78 (PR #253) and serves as the umbrella entry point — but the
per-SDK file is canonical for language-specific tooling commands. Go is
the LAST SDK without a per-SDK CONTRIBUTING.md. Premissa 25 (DevRel +
open SDK > paid marketing) + Premissa 31 (open source MIT — contribution
path must be public).

Scope (1 new file, ~80 LOC):

Create packages/sdk-go/CONTRIBUTING.md with the following sections,
mirroring the structure of packages/sdk-rust/CONTRIBUTING.md (read that
first for tone and section ordering, then adapt to Go-specific commands):

1. **Title + framing** — `# Contributing to the ZettaPay Go SDK`.
   One paragraph: this is the Go binding for the ZettaPay payment
   protocol; PRs welcome for bug fixes, test coverage, doc improvements,
   and parity with the TypeScript canonical SDK.

2. **Wallet-less HARD rule** (verbatim from CLAUDE.md):
   "ZettaPay NUNCA requer conectar carteira. Customer apenas FORNECE a
   chave publica (pubkey/address)." Then list the banned strings
   (`wallet.connect`, `window.solana.connect`, `window.ethereum.connect`,
   `wallet-adapter-react-ui`, `Connect Phantom`, `Connect Wallet`,
   `Connect MetaMask`, `WalletConnect`). Note that the CI gate at
   `.github/workflows/wallet-less-gate.yml` (queued in 9db4cb78 PR #253)
   will reject any PR containing them.

3. **Toolchain** — Go 1.22 or later (matches go.mod's `go 1.22`).
   Standard library only — no third-party deps in the SDK or examples
   (this is a hard constraint that the SDK README already advertises).
   Recommended editor: any with `gopls` LSP support.

4. **Repository layout** — Tree:
   ```
   packages/sdk-go/
   ├── client.go            # public Client + method set
   ├── client_test.go       # unit tests for client
   ├── doc.go               # package-level Go doc
   ├── errors.go            # *Error envelope + IsCode / IsStatus
   ├── go.mod
   ├── retry.go             # DefaultRetryPolicy + exponential backoff
   ├── types.go             # input/output structs
   └── README.md
   ```
   (Adjust the tree to match actual files at PR write time; do not
   invent files.)

5. **Build + test commands**:
   ```
   cd packages/sdk-go
   go build ./...
   go vet ./...
   go test ./...
   go test -race -count=1 ./...
   ```

6. **PR conventions**:
   - Branch naming: `auto/<id>-<slug>` for automated missions; free-form
     for humans.
   - Commit message style: Conventional Commits (`feat(sdk-go)`,
     `fix(sdk-go)`, `test(sdk-go)`, etc.).
   - One logical change per PR; every PR includes a Test plan checklist.

7. **Parity with TypeScript** — The TypeScript SDK in `packages/sdk` is
   the canonical surface; the Go SDK MUST follow its public API shape
   (method names, parameter ordering, error code strings). Surface
   divergence is a bug, not a feature. Open an issue first if a
   parity-breaking change is needed.

8. **License** — Contributions are MIT-licensed; submitting a PR signals
   acceptance.

9. **See also** — Link to the root `CONTRIBUTING.md` (queued in PR #253;
   forward reference is fine — if that file does not yet exist on merge,
   the link still informs).

Anti-scope:
- Do NOT add or modify any code file in packages/sdk-go/.
- Do NOT touch go.mod or go.sum.
- Do NOT introduce a CLA / DCO sign-off requirement — repo is MIT and
  the existing sdk-rust + sdk-python CONTRIBUTING.md files do not
  require either.
- Do NOT mention Claude / Anthropic / OpenAI / any LLM vendor.
- Do NOT mention "revolution / disruption / synergy / game-changer".

Validation:
1. `cat packages/sdk-go/CONTRIBUTING.md | head -1` shows
   `# Contributing to the ZettaPay Go SDK`.
2. `grep -c "^## " packages/sdk-go/CONTRIBUTING.md` returns 9 (one per
   top-level section above; adjust assertion to actual section count
   if you collapse Title into Framing).
3. `grep -E "Claude|Anthropic|OpenAI|revolution|disruption|synergy|game-changer" packages/sdk-go/CONTRIBUTING.md`
   returns zero matches.
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" packages/sdk-go/CONTRIBUTING.md`
   returns 7+ matches — this is EXPECTED (the doc names the banned
   strings to inform contributors). The wallet-less CI gate excludes
   `.md` files from scanning, so the doc does not self-trip.
5. `git diff --stat HEAD` shows exactly one file added:
   packages/sdk-go/CONTRIBUTING.md.

Conflicts:
- None — confirmed by `ls packages/sdk-go/CONTRIBUTING.md 2>&1`
  returning "No such file or directory" on main HEAD (commit 89b0b90).
  No open PR targets this path.

References:
- Sibling: packages/sdk-rust/CONTRIBUTING.md.
- Sibling: packages/sdk-python/CONTRIBUTING.md.
- Root CONTRIBUTING.md mission (queued in 9db4cb78 PR #253).$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 3. sdk-python: tests/test_types.py — freeze + equality + field-shape tests
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-python: tests/test_types.py (freeze + equality on public dataclasses)',
$$Add `packages/sdk-python/tests/test_types.py` to lock the immutability
and equality invariants of the public dataclasses exported from
`zettapay.types`. Listed explicitly as a KNOWN FOLLOW-UP in the 9db4cb78
audit payload (PR #253). Today no test catches a future refactor that
accidentally drops `frozen=True` on `Merchant`, `PaymentRecord`, etc. —
which would silently break consumers that rely on hashable types or
freeze guarantees. Premissa 23 (SDK-first multi-language parity — TS
ships its peer in packages/sdk/test/types.test.ts equivalent surface) +
Premissa 29 (coverage > 70% on critical paths — public types ARE the
consumer-facing contract).

Scope (1 new file, ~150 LOC):

Create packages/sdk-python/tests/test_types.py using pytest (already a
dev-dep — packages/sdk-python/tests/conftest.py exists). Cover the seven
`frozen=True` dataclasses currently exported from
`packages/sdk-python/zettapay/types.py`:

  Merchant, ListMerchantsResponse, PaymentRecord, PayResponse,
  ListPaymentsResponse, HealthStatus, _ApiErrorBody

Plus the one MUTABLE dataclass:

  RetryPolicy

For each `frozen=True` class, assert four invariants:

1. **Construction works** — instantiate with the real field shape (use
   the actual field types from types.py; do NOT invent fields). Example
   for Merchant:
     m = Merchant(id=1, name="acme", wallet_pubkey="7Np41...",
                  usdc_ata="EhpbD...", created_at=1737000000)

2. **frozen=True is enforced** — assigning a field raises
   `dataclasses.FrozenInstanceError`:
     with pytest.raises(FrozenInstanceError):
         m.name = "other"

3. **Equality is value-based** — two instances with the same fields
   compare equal; one with any differing field does not:
     assert m == Merchant(id=1, name="acme", wallet_pubkey="7Np41...",
                          usdc_ata="EhpbD...", created_at=1737000000)
     assert m != Merchant(id=2, name="acme", ...)

4. **Hashable** — frozen dataclasses are hashable by default; the
   instance can live in a set:
     assert {m, m} == {m}

For the MUTABLE `RetryPolicy`, assert:

- **Default field values** match the documented defaults
  (`max_attempts=1`, `initial_backoff=0.1`, `max_backoff=2.0`).
- **Construction with overrides** works.
- **Assignment is allowed** (no FrozenInstanceError):
    rp = RetryPolicy()
    rp.max_attempts = 5
    assert rp.max_attempts == 5

Use parametrize for the seven frozen classes where the assertions are
identical (construction shape differs but assignment-rejection +
equality-symmetry + hashability are uniform). A small fixture factory
keeps each test case to ~5 lines.

Anti-scope:
- Do NOT test the SDK's HTTP transport, retry behavior, webhook
  signature, or async client — separate test files cover those
  (test_client.py, test_async_client.py, test_webhook.py). This file
  is types-only.
- Do NOT mock anything. Pure dataclass introspection.
- Do NOT add a new dev dependency. pytest is already declared.
- Do NOT change zettapay/types.py — additive test only.
- Do NOT add `__init__.py` to tests/ (other tests in the dir do not
  have one — verify with `ls packages/sdk-python/tests/` and match the
  convention).
- Do NOT include any mention of `wallet.connect` etc. — wallet-less
  HARD rule (vacuous; types are wallet-free).

Validation:
1. `cd packages/sdk-python && pytest tests/test_types.py -v` — all
   tests green.
2. `cd packages/sdk-python && pytest` — full suite still green (no
   regressions in test_client, test_async_client, test_webhook).
3. `cd packages/sdk-python && ruff check tests/test_types.py` —
   no lint errors (the queued ci(sdk-python) workflow runs ruff).
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" packages/sdk-python/tests/test_types.py`
   returns zero matches.
5. `git diff --stat HEAD` shows exactly one file added:
   packages/sdk-python/tests/test_types.py.

Conflicts:
- None — confirmed by `ls packages/sdk-python/tests/test_types.py 2>&1`
  returning "No such file or directory" on main HEAD (commit 89b0b90).
  Existing tests in the dir: conftest.py, test_async_client.py,
  test_client.py, test_webhook.py (no overlap).

References:
- Source: packages/sdk-python/zettapay/types.py (seven frozen + one
  mutable dataclass).
- Sibling test pattern: packages/sdk-python/tests/test_client.py
  (pytest style + import paths).
- Sibling test pattern: packages/sdk-python/tests/test_webhook.py.
- Python docs: https://docs.python.org/3/library/dataclasses.html#dataclasses.FrozenInstanceError$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 4. .github/workflows/codeql.yml — GitHub-native security scanning workflow
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci: CodeQL security workflow (JS/TS + Python + Go)',
$$Add `.github/workflows/codeql.yml` that runs GitHub-native CodeQL
static analysis on every PR and on a weekly schedule, covering the
languages where CodeQL is GA (JavaScript / TypeScript, Python, Go).
Listed explicitly as a KNOWN FOLLOW-UP in the 9db4cb78 audit payload
(PR #253). Today the repo has no automated SAST surface; security
auditors expect the GitHub Security tab to populate from CodeQL.
Premissa 18 (smart contracts audited before mainnet — off-chain SDK
surface also needs a baseline scan) + Premissa 29 (quality gate).

Scope (1 new file, ~70 LOC):

Create .github/workflows/codeql.yml with the canonical GitHub CodeQL
matrix workflow. Use the GitHub-published action versions
(`actions/checkout@v4`, `github/codeql-action/init@v3`,
`github/codeql-action/analyze@v3`):

  name: CodeQL

  on:
    push:
      branches: [main]
    pull_request:
      branches: [main]
    schedule:
      # Weekly Monday 06:00 UTC (off-hours for the maintainer TZ).
      - cron: '0 6 * * 1'

  permissions:
    actions: read
    contents: read
    security-events: write

  jobs:
    analyze:
      name: Analyze ${{ matrix.language }}
      runs-on: ubuntu-latest
      timeout-minutes: 20
      strategy:
        fail-fast: false
        matrix:
          language: [javascript-typescript, python, go]
      steps:
        - uses: actions/checkout@v4

        - name: Initialize CodeQL
          uses: github/codeql-action/init@v3
          with:
            languages: ${{ matrix.language }}
            queries: +security-and-quality

        - name: Set up Go (Go matrix slice only)
          if: matrix.language == 'go'
          uses: actions/setup-go@v5
          with:
            go-version-file: packages/sdk-go/go.mod

        - name: Autobuild
          uses: github/codeql-action/autobuild@v3

        - name: Perform CodeQL Analysis
          uses: github/codeql-action/analyze@v3
          with:
            category: "/language:${{ matrix.language }}"

Notes the worker must respect:

- `javascript-typescript` is ONE language slice in CodeQL v3+ (replaces
  the older split `javascript` / `typescript` pair).
- Use `+security-and-quality` query pack (broader than the default
  `security-extended`) to surface lint-grade smells in addition to
  CVE-shaped issues.
- The Go slice needs `actions/setup-go@v5` with `go-version-file:
  packages/sdk-go/go.mod` so CodeQL's autobuild uses the project's
  declared Go version.
- Rust is NOT in the matrix — CodeQL Rust support is beta and requires
  an explicit opt-in we defer (captured in audit known-followups).
- PHP is NOT in the matrix — CodeQL PHP support is supported but the
  sdk-php tree is small (3 source files) and the queued sdk-php phpunit
  workflow + composer audit cover its surface adequately for now.

Anti-scope:
- Do NOT add or modify any code file in src/, packages/, api/, scripts/.
- Do NOT pin CodeQL action versions below v3 — older versions hit
  deprecation warnings.
- Do NOT add `language: rust` (beta, opt-in only).
- Do NOT add `language: ruby` / `language: csharp` / `language: cpp` —
  not used in this repo.
- Do NOT add a self-hosted runner or any paid CI service.
- Do NOT add the workflow to existing files (sdk-go.yml, npm-publish.yml,
  wallet-less-gate.yml when it lands); ship it as a dedicated workflow.
- Do NOT touch CLAUDE.md or any source file — workflow-only PR.
- Wallet-less HARD rule: vacuous (.yml is excluded by the gate).

Validation:
1. `cat .github/workflows/codeql.yml | head -1` shows `name: CodeQL`.
2. YAML parses: `python -c "import yaml; yaml.safe_load(open('.github/workflows/codeql.yml'))"`
   (or any YAML linter) returns no error.
3. Push the branch; GitHub Actions starts the `CodeQL` workflow on PR.
   Three matrix jobs (javascript-typescript, python, go) MUST complete
   (pass or fail — first-run discovery is acceptable; security alerts
   populate the Security tab and are reviewed asynchronously).
4. After merge, the Monday 06:00 UTC schedule lane begins; verify in
   `gh workflow view CodeQL --yaml` one week later.
5. `git diff --stat HEAD` shows exactly one file added:
   .github/workflows/codeql.yml.

Conflicts:
- None — confirmed by `ls .github/workflows/codeql.yml 2>&1` returning
  "No such file or directory" on main HEAD (commit 89b0b90). Existing
  workflows: npm-publish.yml, sdk-go.yml. No open PR targets this path.

References:
- GitHub CodeQL docs:
  https://docs.github.com/en/code-security/code-scanning/automatically-scanning-your-code-for-vulnerabilities-and-errors/configuring-code-scanning
- KNOWN FOLLOW-UP: 9db4cb78 PR #253 audit payload.
- Sibling workflow: .github/workflows/sdk-go.yml.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 5. .tool-versions — polyglot toolchain lock for asdf / mise users
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: .tool-versions polyglot toolchain lock (asdf + mise)',
$$Add a repo-root `.tool-versions` file pinning the minimum versions of
Node, Go, Python, Rust, and PHP that the polyglot monorepo expects.
`.nvmrc` (queued in 03cf9a17 PR #245) covers Node only. `asdf` and
`mise` (the dominant polyglot version managers) both read
`.tool-versions` and provision every toolchain in one command (`asdf
install` / `mise install`). Without it, contributors juggle five
separate version sources (`.nvmrc`, `go.mod`'s `go 1.22`,
`pyproject.toml`'s `python_requires`, `Cargo.toml`'s `rust-version`,
`composer.json`'s `"php": "^8.1"`) and hope they line up. Premissa 25
(DevRel + open SDK > paid marketing) + Premissa 31 (open source MIT —
reproducible dev environment is part of the contribution path).

Scope (1 new file, 5 lines):

Create /.tool-versions at the repo root with one tool per line in
asdf-canonical order (`<tool> <version>`):

  nodejs 20.11.1
  go 1.22.5
  python 3.11.9
  rust 1.76.0
  php 8.3.6

Notes on the version choices (worker MUST verify each against the repo's
own declared minimum before committing — if any conflicts, use the
repo's declared minimum, not the suggestion above):

- **nodejs 20.11.1** — matches the `.nvmrc` queued in 03cf9a17 PR #245
  (`v20.11.1`). If that PR has merged and .nvmrc exists, read it and
  use the EXACT same string (minus the `v` prefix — `.tool-versions`
  uses `nodejs 20.11.1`, not `nodejs v20.11.1`). If .nvmrc does not
  exist yet, use 20.11.1 as written above.
- **go 1.22.5** — matches `packages/sdk-go/go.mod`'s `go 1.22`
  directive (use the latest patch in the 1.22 series at the time of PR
  authoring; check `https://go.dev/dl/` if uncertain). The directive
  pins a minor, not a patch; 1.22.5 is a safe choice as of 2026-05-17.
- **python 3.9 minimum** — `pyproject.toml` in packages/sdk-python
  declares `python_requires>=3.9`. Pin to 3.11.9 (LTS patch) so dev
  catches `match` statements and `TypeAlias` style without permitting
  3.12-only syntax in the SDK.
- **rust stable** — sdk-rust currently uses stable channel; pin to
  1.76.0 (the floor needed for the deps in
  packages/sdk-rust/Cargo.toml; verify with `cargo --version` and
  `grep "rust-version" packages/sdk-rust/Cargo.toml` — if a rust-version
  is declared, use it).
- **php 8.3.6** — packages/sdk-php/composer.json declares `"php":
  "^8.1"`. 8.3.x is current GA and back-compat with 8.1. Pin to 8.3.6.

If asdf / mise plugin naming differs from above for any tool, use the
asdf default plugin name (`nodejs`, `go`, `python`, `rust`, `php`). Do
NOT use mise-specific shortcuts (`node`, `golang`) — `.tool-versions`
is asdf's canonical format and mise reads it for compatibility.

Anti-scope:
- Do NOT add a `.mise.toml` — `.tool-versions` is the lowest-common-
  denominator and both tools read it. `.mise.toml` adds nothing until
  task runners are needed (separate mission if/when needed).
- Do NOT modify `.nvmrc` (queued in 03cf9a17 PR #245). The two files
  coexist; nvm users read .nvmrc, asdf/mise users read .tool-versions.
- Do NOT add an `.asdfrc` file — defaults are fine.
- Do NOT touch go.mod, pyproject.toml, Cargo.toml, composer.json, or
  package.json. Version drift between those manifests and
  .tool-versions is a separate audit-mission concern.
- Do NOT add comments to `.tool-versions` — asdf accepts `# comment`
  lines but mise's older versions choke on them. Keep it 5 lines flat.
- Do NOT include any mention of `wallet.connect` etc. — vacuous
  (plain version pins).

Validation:
1. `cat .tool-versions` returns exactly 5 lines, each in the form
   `<tool> <semver>`.
2. `cat .tool-versions | awk '{print NF}' | sort -u` returns exactly
   `2` (every line has exactly two whitespace-separated tokens).
3. If asdf is installed locally: `asdf install` (in the repo root)
   succeeds for all five tools — best-effort, not a CI gate.
4. If mise is installed locally: `mise install` succeeds — best-effort.
5. `npm run build` and `npm run test` continue to pass — the file is
   inert outside asdf/mise.
6. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" .tool-versions`
   returns zero matches.
7. `git diff --stat HEAD` shows exactly one file added: .tool-versions.

Conflicts:
- None — confirmed by `ls .tool-versions 2>&1` returning "No such file
  or directory" on main HEAD (commit 89b0b90). No open PR targets this
  path. `.nvmrc` (queued in 03cf9a17 PR #245) is the only adjacent
  version-pin file and intentionally does not conflict.

References:
- asdf docs: https://asdf-vm.com/manage/configuration.html#tool-versions
- mise docs: https://mise.jdx.dev/configuration.html#tool-versions
- Sibling (Node-only): .nvmrc (queued in 03cf9a17 PR #245).$$,
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
     'source_mission_uuid_prefix', 'bf6837e4',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/bf6837e4-backlog-refill.md',
     'companion_sql', 'docs/discovery/bf6837e4-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', 'a82d92db'),
       jsonb_build_object('pr', 253, 'uuid_prefix', '9db4cb78')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk-php: examples/quickstart.php (parity with rust/python quickstart)',
       'sdk-go: per-SDK CONTRIBUTING.md (mirror sdk-rust + sdk-python)',
       'sdk-python: tests/test_types.py (freeze + equality on public dataclasses)',
       'ci: CodeQL security workflow (JS/TS + Python + Go)',
       'chore: .tool-versions polyglot toolchain lock (asdf + mise)'
     ),
     'themes', jsonb_build_array(
       'sdk-php-quickstart-parity-last-language',
       'sdk-go-contributing-parity-last-language',
       'sdk-python-types-freeze-equality-tests',
       'github-codeql-security-workflow',
       'polyglot-toolchain-lock-asdf-mise'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk-php (additive examples/, no composer.json change, lint-gated)',
       'packages/sdk-go (markdown only, no compile)',
       'packages/sdk-python (additive pytest, gated by ci(sdk-python).yml queued in 03cf9a17)',
       '.github/workflows/ (CI-only, no source touch)',
       'repo-root (plain text 5-line file, zero compile impact)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors of existing source',
       'reformat-the-world sweeps',
       'CODEOWNERS (deferred — needs human owner decision)',
       'public/manifest.json PWA shell (deferred — needs service worker mission)',
       'CHANGELOG.md (separate mission, needs version policy decision)',
       'CodeQL Rust language pack (beta opt-in, deferred)',
       'CodeQL PHP language pack (sdk-php tree small; phpunit gate covers it)',
       '.mise.toml task-runner config (.tool-versions sufficient)',
       'introducing new third-party deps in any SDK'
     ),
     'known_followups', jsonb_build_array(
       'sdk-rust: examples/webhook.rs (mirror sdk-go webhook example once it lands)',
       'sdk-go: examples/webhook.go (still deferred — fixture-share with sdk-rust)',
       'sdk-python: tests/test__http.py (still deferred — transport-fake fixture mission)',
       'license-checker CI workflow (needs allow-list policy decision)',
       'CodeQL Rust language pack (beta — defer until GA)',
       'CODEOWNERS (still deferred — needs human owner/team decision)',
       'public/manifest.json PWA shell (still deferred — needs service worker mission)',
       'CHANGELOG.md per-SDK (each its own mission once version policy is decided)',
       'sitemap-index when /docs grows past 50k URLs',
       'cross-SDK version-drift audit (between .tool-versions and per-SDK manifests)'
     )
   ));

COMMIT;
