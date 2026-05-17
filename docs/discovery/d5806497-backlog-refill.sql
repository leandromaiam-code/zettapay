-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: d5806497
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/d5806497-backlog-refill.md
-- Ninth refill pass. All 5 picks are single-file, single-objective,
-- additive, and outside the chronic-broken packages/api compile lane.
-- None touch wallet code (HARD rule sanity verified in the .md).
--
-- Themes covered: last-SDK CONTRIBUTING parity (PHP), GitHub-native
-- trust-signal triad (SECURITY.md complementing the queued security.txt),
-- contributor template hygiene (PR template + issue-template config),
-- and PHP exception-module typed-getter test coverage.
--
-- Prior eight refills (drained):
--   #231 fba46358 — SDK errors.ts, LOG_PRETTY, Immunefi, sdk-py+rust webhook
--   #242 69cdcbce — OG meta, robots.txt, footer, html lang, signup handoff
--   #244 4f79ec06 — SDK re-exports, Vercel CORS, /api/pay rate-limit headers
--   #245 03cf9a17 — client.ts vitest, .nvmrc, security.txt, sdk-rust+py CI
--   #251 1986ee3d — sdk-go+php webhook, sdk-php CI, dependabot, embed budget
--   #252 a82d92db — sdk-go errors+retry test, sdk-py errors, mcp.json, editorconfig
--   #253 9db4cb78 — sdk-rust error inline test, sdk-go quickstart, sitemap, wallet-less gate, root CONTRIBUTING
--   #254 bf6837e4 — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-py types test, CodeQL, tool-versions
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-php — last SDK without a per-SDK CONTRIBUTING.md
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-php: ship per-SDK CONTRIBUTING.md',
$$Create `packages/sdk-php/CONTRIBUTING.md` mirroring the structure of `packages/sdk-rust/CONTRIBUTING.md` and `packages/sdk-python/CONTRIBUTING.md`. After PR #254 (`bf6837e4`) queued the Go SDK's CONTRIBUTING.md, PHP is the only SDK without one. Verified on main:

  packages/sdk-rust/CONTRIBUTING.md    exists
  packages/sdk-python/CONTRIBUTING.md  exists
  packages/sdk-go/CONTRIBUTING.md      queued in PR #254
  packages/sdk-php/CONTRIBUTING.md     MISSING

Without per-SDK toolchain guidance, PHP contributors land in the README and guess at `composer install` / `vendor/bin/phpunit` / the PSR-7/17/18 HTTP discovery hint / the PHP `^8.1` floor from `composer.json`. Premissa 25 (DevRel + open SDK > paid marketing) + Premissa 31 (open source SDKs MIT — contribution path must be public).

Scope (1 new file, ~70-100 LOC):

1. Create `packages/sdk-php/CONTRIBUTING.md` at the SDK root.
2. Mirror the section order from `packages/sdk-rust/CONTRIBUTING.md`:
   - One-paragraph intro pointing back to the root CONTRIBUTING.md (queued in PR #253) for monorepo-wide policy.
   - **Development environment** — required PHP ^8.1 + composer ^2.5. Mention the `ext-json` runtime requirement (already in `composer.json`).
   - **Install dependencies** — `composer install` from `packages/sdk-php/`.
   - **Run tests** — `vendor/bin/phpunit` (the repo already ships `phpunit.xml.dist`).
   - **Code style** — there is no `phpcs.xml` / `php-cs-fixer.php` in the SDK yet; note that contributions should follow PSR-12 informally and the file will be tightened up in a follow-up mission (do NOT add a tooling config in this PR).
   - **PSR HTTP discovery** — mention `php-http/discovery` (declared in `composer.json`) auto-resolves a PSR-18 client at runtime; for local dev, `guzzlehttp/psr7` ships under `require-dev` and is the default test fixture.
   - **PR checklist** — same wallet-less hard-rule, brand-discipline (no Claude / Anthropic), Co-author Veridian Fabric items as the Rust/Python files.
   - **License** — MIT, single line.
3. Do NOT modify `composer.json`, `phpunit.xml.dist`, or any source / test file.
4. Do NOT add a `.php-cs-fixer.php`, `phpcs.xml`, or any tooling config — out of scope.

Validation:
- `ls packages/sdk-php/CONTRIBUTING.md` exits 0.
- `wc -l packages/sdk-php/CONTRIBUTING.md` returns >= 40 and <= 130.
- `grep -c '^## ' packages/sdk-php/CONTRIBUTING.md` returns >= 4 (Dev env, Install, Tests, PR checklist).
- `grep -i 'wallet.connect\|window.solana.connect\|Connect Phantom\|Connect Wallet\|Connect MetaMask\|wallet-adapter-react-ui' packages/sdk-php/CONTRIBUTING.md` returns nothing (markdown may mention the banned-string list for awareness — that's fine since the wallet-less CI gate queued in PR #253 excludes `.md` from scanning).
- `npm run build` unaffected (markdown, no compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-contributing`. Open PR titled `docs(sdk-php): ship per-SDK CONTRIBUTING.md`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. SECURITY.md at repo root — GitHub Security tab trust signal
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'security: ship root SECURITY.md (GitHub Security tab)',
$$Create a `SECURITY.md` file at the repo root. GitHub auto-detects this file and renders a "Report a vulnerability" / disclosure-policy entry in the repository's **Security** tab — the canonical surface security researchers expect. PR #245 (`03cf9a17`) queued `public/.well-known/security.txt` (RFC 9116 network-level discovery); this is the **complementary GitHub-level discovery surface**, explicitly handed off in the #245 rationale as "a separate later mission". Together with `audit/BUG_BOUNTY.md` (already in-repo), the three form the standard pre-mainnet trust-signal triad.

Premissa 19 (smart contracts audited + bug bounty $50k pre-mainnet — researchers must be able to find the disclosure channel from any standard entry point).

Scope (1 new file, ~50-70 LOC):

1. Create `SECURITY.md` at the repo root (NOT inside `.github/` — root placement is what GitHub indexes for the Security tab badge; `.github/SECURITY.md` also works but root is preferred when there is no other `.github/` policy collision).
2. File contents should include these sections in this order:
   - **Supported Versions** — short table. Pre-mainnet: only `main` is supported (devnet bytecode); mainnet versions tracked once Z29.4 lands.
   - **Reporting a Vulnerability** — preferred channel = the bug-bounty contact from `audit/BUG_BOUNTY.md`. Include a SHORT email line (`security@zettapay.dev`) and the link to `audit/BUG_BOUNTY.md` for severity + reward tiers. Do NOT inline the bounty amounts — single source of truth in `audit/BUG_BOUNTY.md`.
   - **Disclosure Policy** — 90-day coordinated disclosure default, with a one-sentence note that critical bounty findings may extend the window per Immunefi standard practice.
   - **Out of Scope** — point to `audit/SCOPE.md` (existing) rather than duplicating.
   - **Acknowledgments** — point to `audit/HALL_OF_FAME.md` (link is allowed even if that file is queued separately; do NOT create that file in this PR).
   - **PGP / Encryption** — point to the `Encryption:` URL declared in `security.txt` (queued in #245).
3. Do NOT add a `vercel.json` route — `SECURITY.md` is indexed by GitHub, not by Vercel; it does not need to be served as a webpage.
4. Do NOT duplicate the bounty reward schedule or scope language — every paragraph should point at the canonical source file already in the repo.

Validation:
- `ls SECURITY.md` exits 0 at the repo root.
- `wc -l SECURITY.md` returns >= 30 and <= 100.
- `grep -c '^## ' SECURITY.md` returns >= 5 (Supported Versions, Reporting, Disclosure, Out of Scope, Acknowledgments).
- `grep -c 'audit/BUG_BOUNTY.md' SECURITY.md` returns >= 1.
- `grep -c 'security@zettapay' SECURITY.md` returns >= 1.
- After push to main, the GitHub repo "Security" tab shows the "Security policy" entry (manual verification).
- `npm run build` unaffected (root markdown, no compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-security-md-root`. Open PR titled `security: ship root SECURITY.md (GitHub Security tab)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. PR template — uniform signal for the auto-merge squad
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: .github/PULL_REQUEST_TEMPLATE.md',
$$Create `.github/PULL_REQUEST_TEMPLATE.md`. The repo has 250+ merged PRs and zero PR template — descriptions are inconsistent across human, auto-discovery, sentinel, and execution missions, which makes the auto-merge gate harder to triage. A minimal template that locks in the **wallet-less hard-rule check**, **build-green attestation**, **test plan**, and **Co-author = Veridian Fabric** fields gives mission workers + reviewers a uniform signal.

Premissa 25 (DevRel + DX — first-touch human contributors see the template and follow the convention) + Premissa 26 (toda mission deve ter PR aberto no fim — the template normalises that PR's shape).

Scope (1 new file, ~30-50 LOC):

1. Create `.github/PULL_REQUEST_TEMPLATE.md` (singular file at that exact path; do NOT use the `.github/PULL_REQUEST_TEMPLATE/` directory variant — that's for multiple variants and adds complexity).
2. Template structure (Markdown, plain checklist — no XML form-field syntax):
   - `## Summary` — 1-3 bullets describing the change.
   - `## Wallet-less hard rule` — checkbox: "I have verified `grep -r 'wallet.connect\\|window.solana.connect\\|window.ethereum.connect\\|wallet-adapter-react-ui\\|Connect Phantom\\|Connect Wallet\\|Connect MetaMask' src/ packages/` returns no NEW matches in this diff".
   - `## Build / tests` — checkboxes: `npm run build` green locally, `npm run test` green locally (or N/A if doc-only), wallet-less CI gate passes (queued #253), affected SDK CI passes.
   - `## Test plan` — markdown checklist of TODOs for reviewer to verify.
   - `## Layer 0 premissas touched` — bullets, e.g. "Premissa 23 (SDK-first parity)".
   - `## Brand discipline` — checkbox: "No Claude / Anthropic / OpenAI mentions in commit, PR body, or code comments. Co-author tag = Veridian Fabric".
3. Do NOT make any section a hard form gate (no `required:` markers, no YAML form schema). Plain Markdown only — workers can replace the template body freely without losing CI gating.
4. Do NOT add additional template variants under `.github/PULL_REQUEST_TEMPLATE/*.md` in this PR.

Validation:
- `ls .github/PULL_REQUEST_TEMPLATE.md` exits 0.
- `wc -l .github/PULL_REQUEST_TEMPLATE.md` returns >= 20 and <= 80.
- `grep -c '^## ' .github/PULL_REQUEST_TEMPLATE.md` returns >= 5 (Summary, Wallet-less, Build/tests, Test plan, Brand).
- `grep -c 'Wallet-less' .github/PULL_REQUEST_TEMPLATE.md` returns >= 1.
- `grep -c 'Veridian Fabric' .github/PULL_REQUEST_TEMPLATE.md` returns >= 1.
- The template appears auto-populated when "Open a new PR" is clicked in GitHub UI after merge (manual verification).
- `npm run build` unaffected (GitHub template, no compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-pr-template`. Open PR titled `chore: ship .github/PULL_REQUEST_TEMPLATE.md`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. ISSUE_TEMPLATE config — disable blank issues + route security
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: .github/ISSUE_TEMPLATE/config.yml (route security)',
$$Create `.github/ISSUE_TEMPLATE/config.yml`. The `.github/ISSUE_TEMPLATE/` directory does not exist on main. Without a `config.yml`, GitHub renders the default "open a blank issue" path on the New Issue page, and there is no surfaced link telling researchers to **report security issues via the bounty channel, not as a public issue**. A 10-15 line `config.yml` with `blank_issues_enabled: false` plus a `contact_links:` block (one entry pointing at `audit/BUG_BOUNTY.md` for security, one pointing at the SECURITY.md disclosure flow once it lands) closes the disclosure footgun.

Premissa 19 (bug bounty pre-mainnet — researchers must be steered AWAY from public issue threads) + Premissa 25 (DX — first-touch contributors see a clean, intent-routed New Issue page).

Scope (1 new file, ~10-15 LOC):

1. Create `.github/ISSUE_TEMPLATE/config.yml`.
2. File contents:
   ```yaml
   blank_issues_enabled: false
   contact_links:
     - name: Report a security vulnerability (do NOT open a public issue)
       url: https://github.com/leandromaiam-code/zettapay/blob/main/audit/BUG_BOUNTY.md
       about: Security disclosures go via the bug-bounty channel. Public issues for vulnerabilities will be deleted.
     - name: Ask a question / share an idea
       url: https://github.com/leandromaiam-code/zettapay/discussions
       about: Use GitHub Discussions for usage questions, integration help, and feature ideas.
   ```
3. The Discussions URL is fine even if Discussions is not enabled — GitHub renders the link and clicking it surfaces a "Discussions are not enabled" prompt, which is benign. Enabling Discussions is a separate repo-admin mission.
4. Do NOT add `bug_report.yml` / `feature_request.yml` / `sdk_issue.yml` form templates in this PR — those are non-trivial form-field design calls and each SDK / surface wants a different shape. `config.yml` alone is the auto-merge-safe scope.
5. Do NOT add `assignees` / `labels` top-level keys — those belong on individual form templates, not on `config.yml`.

Validation:
- `ls .github/ISSUE_TEMPLATE/config.yml` exits 0.
- `python -c "import yaml; cfg = yaml.safe_load(open('.github/ISSUE_TEMPLATE/config.yml')); assert cfg.get('blank_issues_enabled') is False; assert len(cfg.get('contact_links', [])) >= 1"` exits 0.
- `grep -c 'BUG_BOUNTY.md' .github/ISSUE_TEMPLATE/config.yml` returns >= 1.
- After merge, opening "New Issue" on GitHub UI shows the two contact links and NO blank-issue option (manual verification).
- `npm run build` unaffected (GitHub template config, no compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-issue-template-config`. Open PR titled `chore: ship .github/ISSUE_TEMPLATE/config.yml (route security)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. sdk-php exception module — typed-getter isolated test coverage
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-php: tests/Exception/ExceptionTest.php (typed-getter cover)',
$$Create `packages/sdk-php/tests/Exception/ExceptionTest.php` to lock down the typed-getter + inheritance contract of the three classes in `packages/sdk-php/src/Exception/`:

  ZettaPayException.php   11 LOC — base class extends \RuntimeException
  ApiException.php        29 LOC — adds statusCode, errorCode, requestId, body
  NetworkException.php    24 LOC — adds previous + helper getters

The existing `tests/ClientTest.php` exercises these exceptions inside HTTP-mock integration scenarios (20 grep matches today), but the **typed getter contract** in isolation — constructor arity, accessor correctness, inheritance chain, `body` return type — is never asserted. A future refactor that drops a getter or breaks `extends ZettaPayException` would slip past the integration-style tests.

This mirrors how `packages/sdk-python/zettapay/types.py` is being locked down by the dedicated `tests/test_types.py` queued in PR #254 (`bf6837e4`) — same module-level test pattern, applied to PHP's exception module.

Premissa 23 (SDK-first multi-language parity — same test shape across all SDKs) + Premissa 29 (coverage > 70% on critical paths; typed errors are the consumer-facing contract).

Scope (1 new file, ~80-130 LOC):

1. Create `packages/sdk-php/tests/Exception/ExceptionTest.php` (note: `tests/Exception/` subdirectory matches the source `src/Exception/` layout — make the directory).
2. PHPUnit 10.5 namespace under `ZettaPay\\Tests\\Exception\\` (the root composer.json already declares `"ZettaPay\\Tests\\": "tests/"` autoload-dev — PSR-4 picks up the subdir automatically; no composer.json change needed).
3. Tests to ship (use `\PHPUnit\Framework\TestCase`):
   - `testZettaPayExceptionExtendsRuntimeException()` — `assertInstanceOf(\RuntimeException::class, new ZettaPayException('msg'))`.
   - `testApiExceptionConstructorArity()` — verify the constructor accepts message + statusCode + errorCode + requestId + body in that order (read the actual source to confirm parameter order — DO NOT guess).
   - `testApiExceptionGetters()` — `getStatusCode()`, `getErrorCode()`, `getRequestId()`, `getBody()` return the constructor values verbatim.
   - `testApiExceptionBodyIsArrayOrNull()` — instantiate with `body = ['error' => 'foo']`, assert `getBody()` returns `['error' => 'foo']`; instantiate with no body, assert `getBody()` returns null. The body MUST be array-or-null, never a string (that contract matters for downstream JSON-decode consumers).
   - `testApiExceptionInheritsZettaPayException()` — `assertInstanceOf(ZettaPayException::class, new ApiException('msg'))`.
   - `testNetworkExceptionRetainsPrevious()` — pass a `\RuntimeException('inner')` as previous; assert `getPrevious()` returns it (read source for the exact parameter order).
   - `testNetworkExceptionInheritsZettaPayException()` — `assertInstanceOf(ZettaPayException::class, new NetworkException('msg'))`.
   - One smoke test per class for `getMessage()` round-trip.
4. **Read the actual source files** (`packages/sdk-php/src/Exception/*.php`) BEFORE writing assertions — constructor parameter order, optional vs required, and default values are the contract. Do NOT guess from the names.
5. Do NOT touch `composer.json`, `phpunit.xml.dist`, or any `src/` file.
6. Do NOT add `Mockery` / `Prophecy` dependencies — PHPUnit's stock asserts (`assertSame`, `assertNull`, `assertInstanceOf`) cover this entirely.
7. Do NOT alter or extend the existing `tests/ClientTest.php` — keep this PR strictly additive at one file.

Validation:
- `cd packages/sdk-php && composer install && vendor/bin/phpunit tests/Exception/ExceptionTest.php` exits 0 with all test cases passing.
- `vendor/bin/phpunit` (full suite) still exits 0 — no regressions in ClientTest / RetryPolicyTest.
- `grep -c 'public function test' packages/sdk-php/tests/Exception/ExceptionTest.php` returns >= 7.
- `grep -c 'assertInstanceOf' packages/sdk-php/tests/Exception/ExceptionTest.php` returns >= 3.
- `npm run build` unaffected (PHP test file is not in any TS compile path).
- Wallet-less hard rule N/A — pure PHPUnit on typed exceptions, no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-exception-test`. Open PR titled `test(sdk-php): cover Exception module typed getters + inheritance`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', 'd5806497',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/d5806497-backlog-refill.md',
     'companion_sql', 'docs/discovery/d5806497-backlog-refill.sql',
     'pass_number', 9,
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', 'a82d92db'),
       jsonb_build_object('pr', 253, 'uuid_prefix', '9db4cb78'),
       jsonb_build_object('pr', 254, 'uuid_prefix', 'bf6837e4')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk-php: ship per-SDK CONTRIBUTING.md',
       'security: ship root SECURITY.md (GitHub Security tab)',
       'chore: .github/PULL_REQUEST_TEMPLATE.md',
       'chore: .github/ISSUE_TEMPLATE/config.yml (route security)',
       'sdk-php: tests/Exception/ExceptionTest.php (typed-getter cover)'
     ),
     'themes', jsonb_build_array(
       'last-sdk-contributing-parity',
       'github-trust-signal-triad',
       'contributor-template-hygiene',
       'sdk-php-exception-typed-coverage'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk-php (PHPUnit, no TS compile)',
       'SECURITY.md / CONTRIBUTING.md (root + sdk markdown)',
       '.github/PULL_REQUEST_TEMPLATE.md (template, non-compile)',
       '.github/ISSUE_TEMPLATE/config.yml (GitHub config, non-compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors',
       'strategic / legal / ops decisions (CODE_OF_CONDUCT, FUNDING, CHANGELOG, CODEOWNERS)',
       'bug_report.yml / feature_request.yml form templates'
     )
   ));

COMMIT;
