-- Auto-discovery backlog refill — generated 2026-05-16
-- Source mission UUID prefix: 03cf9a17
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/03cf9a17-backlog-refill.md
-- All 5 picks are single-file, single-objective, additive, and outside the
-- chronic-broken packages/api compile lane. None touch wallet code.
--
-- Themes covered: TS SDK test coverage, per-SDK CI gating, root-level DX +
-- RFC-9116 trust signals. Prior three refills (fba46358, 69cdcbce, 4f79ec06)
-- drained the site-launch / Vercel-edge / SDK re-export queues; this pass
-- targets the next-layer surfaces that were left untouched.
--
-- The mission worker could not reach Supabase MCP directly (see worker memory
-- feedback_supabase_mcp_unavailable.md); these statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. TS SDK — cover client.ts (the only untested module in packages/sdk/src/)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk: cover client.ts with vitest',
$$Add a new test file `packages/sdk/test/client.test.ts` that unit-tests the public client surface in `packages/sdk/src/client.ts` (149 LOC). Today every other module in `packages/sdk/src/` has a peer test file (`derive`, `errors`, `helpers`, `onchain`, `solana-pay`, `webhook`) — `client.ts` is the only gap. Premissa 29 requires coverage > 70% on critical paths, and the client is the most critical path (every SDK consumer instantiates it).

Scope (1 new file, ~120-180 LOC):

1. Create `packages/sdk/test/client.test.ts`.
2. Mock axios with `vi.mock('axios')` — mirror the pattern used in `packages/sdk/test/helpers.test.ts` (do NOT add `axios-mock-adapter` or `nock` as a new dependency).
3. Cover at minimum:
   - Constructor — default baseURL, custom baseURL, missing API key throws or is allowed (whichever is the actual behavior), timeout default + override, custom axios instance injection if supported.
   - Authorization header — verify `Authorization: Bearer <apiKey>` is set on requests.
   - Public methods — for each exported method on the client class, one happy-path test (returns parsed response) and one error-path test (axios throws → assert the error is mapped via `fromAxiosError` from `errors.ts`).
   - Header forwarding — verify any `Idempotency-Key`, `X-ZettaPay-*`, or custom-headers params reach the underlying axios call.
4. Use `describe` blocks per method, `it` per case. Reset mocks between tests via `beforeEach(() => vi.clearAllMocks())`.
5. Do NOT refactor `client.ts` itself — tests only. If a method is hard to test, document why with one comment line; do not change production code in this PR.

Validation:
- `cd packages/sdk && npm run test` exits 0 with the new file's tests passing.
- `npx vitest run test/client.test.ts --coverage` (if coverage tooling is wired) reports >70% line coverage on `src/client.ts`. If coverage tooling is NOT wired, manual inspection of test cases covers all exported methods.
- `npm run build` unaffected (test files are not in `tsconfig.build.json` include[]; per worker memory `feedback_tsconfig_build_allowlist.md` this is intentional).
- Wallet-less hard rule N/A — no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-client-tests`. Open PR titled `test(sdk): cover client.ts with vitest`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. .nvmrc — pin Node 20 for consistent dev / CI / Vercel runtime
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: pin Node 20 via .nvmrc',
$$Create a new `.nvmrc` file at the repo root containing exactly the line `20` (no trailing comment, no quotes, no `v` prefix — that's the canonical nvm/fnm/asdf format). The repo's `package.json` only declares the loose `"engines": { "node": ">=18.18" }`, but `.github/workflows/npm-publish.yml` already pins `node-version: '20'` and Vercel runs the serverless functions on Node 20.x. Without `.nvmrc`, `nvm use` / `fnm use` / `asdf install nodejs` all fall back to whatever the contributor happens to have installed, and new contributors hit cryptic TS errors when they're on Node 18 with workspace code that relies on Node-20 syntax or stdlib.

Scope (1 new file, 1 line):

1. Create `.nvmrc` at the repo root.
2. File contents (literal, no trailing whitespace beyond final newline):
   ```
   20
   ```
3. Do NOT change `engines.node` in any `package.json` — that's a separate breaking-change discussion. Do NOT add `.tool-versions` (asdf-specific) or `.node-version` (corepack-adjacent) in this PR.

Validation:
- `cat .nvmrc` outputs `20\n` (single line + trailing newline).
- `wc -l .nvmrc` returns `1`.
- `nvm use` inside the repo root prints `Now using node v20.x.x` (assuming Node 20 is installed locally).
- `npm run build` unaffected (`.nvmrc` is read by nvm/CI, not by Node).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-nvmrc-pin-node-20`. Open PR titled `chore: pin Node 20 via .nvmrc`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. RFC-9116 security.txt — discoverable bug-bounty contact for security researchers
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'security: ship public/.well-known/security.txt (RFC 9116)',
$$Create a new file `public/.well-known/security.txt` per RFC 9116 so security researchers running automated `securitytxt.org` scrapers (or the Immunefi devnet listing crawler) can find the ZettaPay disclosure contact + bug-bounty policy. Today `https://zettapay.vercel.app/.well-known/security.txt` 404s — the `audit/BUG_BOUNTY.md` is in-repo but not network-discoverable. Premissa 19 mandates a $50k public bug-bounty pre-mainnet; this is the canonical discovery surface every Stripe-grade payments operator ships.

Scope (1 new file, ~12 lines):

1. Create `public/.well-known/security.txt` (Vercel serves `public/` as static assets, so the file is reachable without a `vercel.json` route change).
2. File contents must follow RFC 9116 field syntax (each field on its own line, `Key: value`):
   ```
   Contact: mailto:security@zettapay.dev
   Expires: 2027-05-16T23:59:59Z
   Encryption: https://zettapay.vercel.app/.well-known/security-pgp.asc
   Preferred-Languages: en, pt-BR
   Canonical: https://zettapay.vercel.app/.well-known/security.txt
   Policy: https://github.com/leandromaiam-code/zettapay/blob/main/audit/BUG_BOUNTY.md
   Acknowledgments: https://github.com/leandromaiam-code/zettapay/blob/main/audit/HALL_OF_FAME.md
   ```
3. The `Expires` field MUST be at least 6 months in the future (RFC 9116 §2.5.5). Use `2027-05-16T23:59:59Z`.
4. The `Encryption` line is optional but expected by serious researchers. If `security-pgp.asc` does not exist yet, leave the line in (the URL 404 is itself a separate mission — do not block on it).
5. The `Acknowledgments` URL similarly may 404 today; leave it in as the canonical pointer.
6. Do NOT add a route rewrite in `vercel.json` — Vercel serves `public/.well-known/*` natively under the same path. Do NOT add any HTML / JSON output formats; security.txt is plain text only.

Validation:
- `cat public/.well-known/security.txt` shows all 7 fields above in the exact order.
- `grep -c '^Contact:' public/.well-known/security.txt` returns exactly 1.
- `grep -c '^Expires:' public/.well-known/security.txt` returns exactly 1.
- `grep -c '^Canonical:' public/.well-known/security.txt` returns exactly 1.
- After deploy, `curl -sI https://zettapay.vercel.app/.well-known/security.txt` returns 200 with `Content-Type: text/plain` (Vercel infers from the `.txt` extension).
- `npm run build` unaffected (static asset, no compile).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-security-txt-rfc9116`. Open PR titled `security: ship .well-known/security.txt (RFC 9116)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. SDK-Rust CI — cargo check + clippy + test on every PR
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci(sdk-rust): cargo check + clippy + test workflow',
$$Create `.github/workflows/sdk-rust.yml` so every push to `main` and every PR that touches `packages/sdk-rust/**` runs `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo build --all-targets`, and `cargo test --all-targets`. Today `.github/workflows/` only contains `npm-publish.yml` (release-only) and `sdk-go.yml` (Go SDK CI); Rust changes ship with no CI gate at all, even though `packages/sdk-rust/` has a real test suite (`tests/integration.rs`, `tests/webhook.rs`). Premissa 23 (SDK-first) + Premissa 29 (Quality Gate) both demand per-SDK CI parity.

Scope (1 new file, ~35 LOC):

1. Create `.github/workflows/sdk-rust.yml` mirroring the structure of the existing `sdk-go.yml`.
2. Workflow contents:
   ```yaml
   name: sdk-rust

   on:
     push:
       branches: [main]
       paths:
         - 'packages/sdk-rust/**'
         - '.github/workflows/sdk-rust.yml'
     pull_request:
       paths:
         - 'packages/sdk-rust/**'
         - '.github/workflows/sdk-rust.yml'

   jobs:
     check:
       runs-on: ubuntu-latest
       defaults:
         run:
           working-directory: packages/sdk-rust
       steps:
         - uses: actions/checkout@v4
         - uses: dtolnay/rust-toolchain@stable
           with:
             toolchain: 1.75.0
             components: rustfmt, clippy
         - uses: Swatinem/rust-cache@v2
           with:
             workspaces: packages/sdk-rust
         - name: cargo fmt --check
           run: cargo fmt --all -- --check
         - name: cargo clippy
           run: cargo clippy --all-targets -- -D warnings
         - name: cargo build
           run: cargo build --all-targets
         - name: cargo test
           run: cargo test --all-targets
   ```
3. The toolchain version `1.75.0` matches `rust-version = "1.75"` in `packages/sdk-rust/Cargo.toml`. If the Cargo.toml `rust-version` has been bumped since this mission was filed, use the current value.
4. Do NOT make this workflow required-status-check yet — that's a separate repo-admin mission. Adding the workflow file is enough to surface failures on PRs.
5. Do NOT add a publish-to-crates.io job in this file. That belongs in a separate `sdk-rust-publish.yml` mission.
6. Do NOT touch `packages/sdk-rust/Cargo.toml` or any source file in this PR.

Validation:
- `node -e "const yaml=require('yaml');yaml.parse(require('fs').readFileSync('.github/workflows/sdk-rust.yml','utf8'))"` exits 0 (valid YAML). If `yaml` package isn't installed, fall back to `python -c "import yaml; yaml.safe_load(open('.github/workflows/sdk-rust.yml'))"`.
- `grep -c 'cargo clippy' .github/workflows/sdk-rust.yml` returns >= 1.
- `grep -c 'cargo test' .github/workflows/sdk-rust.yml` returns >= 1.
- `grep -c 'paths:' .github/workflows/sdk-rust.yml` returns exactly 2 (push + pull_request).
- The workflow appears in the GitHub Actions tab after push (manual verification).
- `npm run build` unaffected (workflows are not compiled).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-ci-sdk-rust`. Open PR titled `ci(sdk-rust): cargo check + clippy + test workflow`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. SDK-Python CI — pytest + ruff on every PR
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci(sdk-python): pytest + ruff workflow',
$$Create `.github/workflows/sdk-python.yml` so every push to `main` and every PR that touches `packages/sdk-python/**` runs `ruff check` + `pytest`. Today `packages/sdk-python/tests/` has a full suite (`conftest.py`, `test_async_client.py`, `test_client.py`, `test_webhook.py`) but **nothing in CI runs them** — only `npm-publish.yml` (release-only) and `sdk-go.yml` exist in `.github/workflows/`. `pyproject.toml` already declares `[project.optional-dependencies] test = ["pytest>=7", "pytest-asyncio>=0.21"]` and supports Python 3.9–3.13; we are one workflow file from gating. Premissa 23 (SDK-first) + Premissa 29 (Quality Gate).

Scope (1 new file, ~35 LOC):

1. Create `.github/workflows/sdk-python.yml`.
2. Workflow contents:
   ```yaml
   name: sdk-python

   on:
     push:
       branches: [main]
       paths:
         - 'packages/sdk-python/**'
         - '.github/workflows/sdk-python.yml'
     pull_request:
       paths:
         - 'packages/sdk-python/**'
         - '.github/workflows/sdk-python.yml'

   jobs:
     test:
       runs-on: ubuntu-latest
       strategy:
         fail-fast: false
         matrix:
           python-version: ['3.9', '3.11', '3.13']
       defaults:
         run:
           working-directory: packages/sdk-python
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-python@v5
           with:
             python-version: ${{ matrix.python-version }}
             cache: pip
             cache-dependency-path: packages/sdk-python/pyproject.toml
         - name: Install package + test deps
           run: pip install -e '.[test]'
         - name: Install ruff
           run: pip install ruff
         - name: ruff check
           run: ruff check zettapay tests
         - name: pytest
           run: pytest tests/ -v
   ```
3. The matrix entries `3.9 / 3.11 / 3.13` cover the floor (`requires-python = ">=3.9"`) plus a middle stable + current. Do NOT add `3.10` / `3.12` to the matrix — keep CI minutes lean; the three picks already span the range.
4. If `pyproject.toml` does NOT already include a `[tool.ruff]` config block, `ruff check zettapay tests` will use ruff's defaults — that's intentional. Tuning ruff config is a separate mission.
5. Do NOT add a publish-to-PyPI job in this file. That belongs in a separate `sdk-python-publish.yml` mission.
6. Do NOT touch `packages/sdk-python/pyproject.toml` or any source/test file in this PR.

Validation:
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/sdk-python.yml'))"` exits 0 (valid YAML).
- `grep -c 'pytest' .github/workflows/sdk-python.yml` returns >= 1.
- `grep -c 'ruff' .github/workflows/sdk-python.yml` returns >= 2 (install + check).
- `grep -c 'python-version' .github/workflows/sdk-python.yml` returns >= 2 (matrix + setup-python).
- The workflow appears in the GitHub Actions tab after push (manual verification).
- `npm run build` unaffected (workflows are not compiled).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-ci-sdk-python`. Open PR titled `ci(sdk-python): pytest + ruff workflow`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', '03cf9a17',
     'generated_at', '2026-05-16T00:00:00Z',
     'companion_doc', 'docs/discovery/03cf9a17-backlog-refill.md',
     'companion_sql', 'docs/discovery/03cf9a17-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk: cover client.ts with vitest',
       'chore: pin Node 20 via .nvmrc',
       'security: ship public/.well-known/security.txt (RFC 9116)',
       'ci(sdk-rust): cargo check + clippy + test workflow',
       'ci(sdk-python): pytest + ruff workflow'
     ),
     'themes', jsonb_build_array(
       'ts-sdk-test-coverage',
       'per-sdk-ci-gating',
       'root-level-dx',
       'rfc-9116-trust-signals'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk/test (vitest workspace, green)',
       '.nvmrc root config (non-compile)',
       'public/.well-known (static asset)',
       '.github/workflows (CI config, non-compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors',
       'strategic / legal / routing decisions'
     )
   ));

COMMIT;
