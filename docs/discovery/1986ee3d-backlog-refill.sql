-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 1986ee3d
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/1986ee3d-backlog-refill.md
-- All 5 picks are single-objective, additive, and outside the chronic-broken
-- packages/api compile lane. None touch wallet code.
--
-- Themes covered: polyglot SDK webhook parity (Go + PHP), per-SDK CI parity
-- (PHP), repo-level supply-chain hygiene (dependabot), embed bundle-size
-- regression gate.
--
-- Prior four refills (fba46358 #231, 69cdcbce #242, 4f79ec06 #244,
-- 03cf9a17 #245) drained the single-objective / site-launch / SDK + Vercel
-- API / test-CI-DX queues. This pass targets the next-layer surfaces.
--
-- The mission worker could not reach Supabase MCP directly (see worker memory
-- feedback_supabase_mcp_unavailable.md); these statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-go: webhook signature verifier — parity with TS / Python / Rust
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-go: webhook signature verifier',
$$Add a webhook signature verifier to the Go SDK so Go consumers can validate
inbound ZettaPay webhook deliveries without rolling their own HMAC code. The
TypeScript (`packages/sdk/src/webhook.ts`), Python
(`packages/sdk-python/zettapay/webhook.py`, landed in #235), and Rust
(`packages/sdk-rust/src/webhook.rs`, landed in #236) SDKs all expose this
helper. Go is the language parity gap. Premissa 9 (Stripe-grade webhooks) +
Premissa 23 (SDK-first).

Scope (2 new files, ~80 + ~120 LOC):

1. Create `packages/sdk-go/webhook.go` exporting:
   - `type WebhookEvent struct { ID string; Type string; CreatedAt time.Time; Data json.RawMessage }`
     — minimal envelope; do NOT add per-event-type discriminated unions in this PR.
   - `func ParseWebhook(payload []byte, signatureHeader string, secret string, tolerance time.Duration) (*WebhookEvent, error)`
     — full-fat verifier: parses the `X-ZettaPay-Signature` header (format
     `t=<unix>,v1=<hex>`), recomputes `HMAC-SHA256(secret, "{t}.{payload}")`,
     constant-time compares via `hmac.Equal`, then unmarshals JSON.
   - `func VerifyWebhookSignature(payload []byte, signatureHeader string, secret string, tolerance time.Duration) error`
     — verifier-only (no JSON parse), for consumers that want to validate
     before reading the body.
   - Tolerance default: `300 * time.Second` (mirrors Python `parse_webhook`
     default; consistent across SDKs).
   - Sentinel errors via `errors.New` or a small typed-error pattern
     consistent with the existing `errors.go`:
       - `ErrWebhookMissingSignature`
       - `ErrWebhookMalformedSignature`
       - `ErrWebhookInvalidSignature`
       - `ErrWebhookTimestampOutsideTolerance`
       - `ErrWebhookPayloadNotJSON`
2. Create `packages/sdk-go/webhook_test.go` covering:
   - Happy path — valid signature within tolerance returns parsed event.
   - Wrong secret — returns `ErrWebhookInvalidSignature`.
   - Tampered payload — returns `ErrWebhookInvalidSignature`.
   - Stale timestamp — returns `ErrWebhookTimestampOutsideTolerance`.
   - Empty header — returns `ErrWebhookMissingSignature`.
   - Malformed header (missing `t=` or `v1=`) — returns `ErrWebhookMalformedSignature`.
   - Non-JSON payload (post-signature) — returns `ErrWebhookPayloadNotJSON` from `ParseWebhook` but NOT from `VerifyWebhookSignature`.
   - Constant-time compare confirmed — at minimum reference `hmac.Equal`
     (do not write a timing-attack benchmark; assertion-of-use is enough).
3. Standard library only — no third-party imports. The Go SDK README claims
   "Zero third-party dependencies — standard library only" and this verifier
   MUST preserve that claim.
4. Do NOT add a Gin / Echo / Chi middleware adapter in this PR — verifier
   surface only. Framework adapters are a separate mission.
5. Do NOT modify `packages/sdk-go/client.go`, `types.go`, `errors.go`, or
   `retry.go`. Pure additive change.

Validation:
- `cd packages/sdk-go && go vet ./...` exits 0.
- `cd packages/sdk-go && go build ./...` exits 0.
- `cd packages/sdk-go && go test -race -count=1 -timeout=60s ./...` exits 0
  with all new webhook tests passing.
- `.github/workflows/sdk-go.yml` already gates these three commands on PR;
  the PR's `sdk-go` check must be green before merge.
- `npm run build` unaffected (Go SDK is outside the Node compile graph).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-go-webhook-verifier`. Open PR titled
`feat(sdk-go): webhook signature verifier`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. sdk-php: webhook signature verifier — parity with TS / Python / Rust
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-php: webhook signature verifier',
$$Add a webhook signature verifier to the PHP SDK so PHP consumers can validate
inbound ZettaPay webhook deliveries without rolling their own HMAC. The
TypeScript (#88 / `packages/sdk/src/webhook.ts`), Python (#235), and Rust
(#236) SDKs all expose this helper; PHP is the remaining language gap.
Premissa 9 (Stripe-grade webhooks) + Premissa 23 (SDK-first).

Scope (2 new files, ~90 + ~140 LOC):

1. Create `packages/sdk-php/src/Webhook.php`:
   - `namespace ZettaPay;` (matches existing PSR-4 autoload in `composer.json`).
   - `final class Webhook` with these `public static` methods:
     - `Webhook::verifySignature(string $payload, string $signatureHeader, string $secret, int $toleranceSeconds = 300): void`
       — throws `WebhookException` subclass on any failure; returns void on success.
     - `Webhook::parseEvent(string $payload, string $signatureHeader, string $secret, int $toleranceSeconds = 300): array`
       — verifies then `json_decode($payload, true, flags: JSON_THROW_ON_ERROR)`.
   - Header format `t=<unix>,v1=<hex>` (mirror across SDKs).
   - Use `hash_hmac('sha256', "{$t}.{$payload}", $secret)` for the digest.
   - Use `hash_equals($expectedHex, $providedHex)` for constant-time
     comparison (required — `===` is timing-attack-vulnerable on PHP strings).
2. Create `packages/sdk-php/src/Exception/WebhookException.php` extending
   the existing `ZettaPayException` from
   `packages/sdk-php/src/Exception/ZettaPayException.php`. Add four typed
   subclasses inside the same file (or one per file, mission worker's
   call — keep it consistent with the existing Exception/ layout):
     - `MissingSignatureException`
     - `MalformedSignatureException`
     - `InvalidSignatureException`
     - `TimestampOutsideToleranceException`
   Each can be a one-line subclass — the goal is typed `catch` blocks for
   consumers.
3. Create `packages/sdk-php/tests/WebhookTest.php` with `phpunit\Framework\TestCase`:
   - Happy path — valid signature within tolerance returns the decoded array.
   - Wrong secret — throws `InvalidSignatureException`.
   - Tampered payload — throws `InvalidSignatureException`.
   - Stale timestamp — throws `TimestampOutsideToleranceException`.
   - Empty header — throws `MissingSignatureException`.
   - Malformed header — throws `MalformedSignatureException`.
   - Non-JSON payload (after valid signature) — throws (any descendant of
     `\JsonException` is acceptable since we requested `JSON_THROW_ON_ERROR`).
4. Use core PHP only — `hash_hmac`, `hash_equals`, `json_decode`. Do NOT
   add a new entry to `composer.json` require[]. Existing dev requirements
   (`phpunit/phpunit ^10.5`) already cover testing.
5. Do NOT add a PSR-15 middleware adapter in this PR — verifier surface
   only. Framework adapters are a separate mission.
6. Do NOT modify `Client.php`, `ClientConfig.php`, `RetryPolicy.php`, or
   the existing `Exception/` files. Pure additive change.

Validation:
- `cd packages/sdk-php && composer install` exits 0 (locally; CI does this on its own).
- `cd packages/sdk-php && ./vendor/bin/phpunit` exits 0 with all webhook tests
  passing. (If `vendor/` is missing, run `composer install` first.)
- `phpunit.xml.dist` already declares the `tests/` directory under
  `<testsuite>`; new file is picked up automatically.
- `npm run build` unaffected (PHP SDK is outside the Node compile graph).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-webhook-verifier`. Open PR titled
`feat(sdk-php): webhook signature verifier`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. CI(sdk-php): phpunit workflow — gate the existing PHP test suite
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci(sdk-php): phpunit workflow',
$$Create `.github/workflows/sdk-php.yml` so every push to `main` and every PR
that touches `packages/sdk-php/**` runs `composer install` + `phpunit`. Today
`packages/sdk-php/tests/` has a real suite (`ClientTest.php`,
`RetryPolicyTest.php`, plus `Fake/` test doubles) gated by
`phpunit.xml.dist` (PHPUnit 10.5, `failOnWarning="true"`, `failOnRisky="true"`)
but **nothing in CI runs them** — only `npm-publish.yml`, `sdk-go.yml`,
`sdk-rust.yml` (queued in pass 03cf9a17), and `sdk-python.yml` (queued in
pass 03cf9a17) exist or are queued. Premissa 23 (SDK-first) + Premissa 29
(Quality Gate) demand per-SDK CI parity.

Scope (1 new file, ~40 LOC):

1. Create `.github/workflows/sdk-php.yml`.
2. Workflow contents (mirror `sdk-go.yml` + `sdk-python.yml` shape):
   ```yaml
   name: sdk-php

   on:
     push:
       branches: [main]
       paths:
         - 'packages/sdk-php/**'
         - '.github/workflows/sdk-php.yml'
     pull_request:
       paths:
         - 'packages/sdk-php/**'
         - '.github/workflows/sdk-php.yml'

   jobs:
     test:
       runs-on: ubuntu-latest
       strategy:
         fail-fast: false
         matrix:
           php-version: ['8.1', '8.2', '8.3']
       defaults:
         run:
           working-directory: packages/sdk-php
       steps:
         - uses: actions/checkout@v4
         - name: Setup PHP
           uses: shivammathur/setup-php@v2
           with:
             php-version: ${{ matrix.php-version }}
             extensions: json, mbstring
             coverage: none
             tools: composer:v2
         - name: Cache Composer
           uses: actions/cache@v4
           with:
             path: packages/sdk-php/vendor
             key: composer-${{ matrix.php-version }}-${{ hashFiles('packages/sdk-php/composer.json') }}
         - name: Install dependencies
           run: composer install --no-interaction --no-progress --prefer-dist
         - name: Run phpunit
           run: ./vendor/bin/phpunit --colors=never
   ```
3. Matrix `8.1 / 8.2 / 8.3` covers the floor (`composer.json` declares
   `"php": "^8.1"`) plus the two newest stable branches. Do NOT add PHP 8.4
   to the matrix yet — `shivammathur/setup-php` supports it but PHPUnit 10.5
   has minor compat warnings; add 8.4 in a follow-up once 8.4 is GA-stable.
4. Do NOT add a Composer-publish-to-Packagist job in this file — that's a
   separate `sdk-php-publish.yml` mission.
5. Do NOT touch `composer.json`, `phpunit.xml.dist`, or any source/test
   file in this PR.
6. Do NOT add `phpstan` or `php-cs-fixer` lint steps in this PR — tests
   only. Static analysis is a separate mission once the test gate lands.

Validation:
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/sdk-php.yml'))"`
  exits 0 (valid YAML). Fall back to
  `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/sdk-php.yml','utf8'))"`
  if Python is unavailable.
- `grep -c 'phpunit' .github/workflows/sdk-php.yml` returns >= 2 (install + run).
- `grep -c 'php-version' .github/workflows/sdk-php.yml` returns >= 2 (matrix + setup-php).
- `grep -c 'paths:' .github/workflows/sdk-php.yml` returns exactly 2 (push + pull_request).
- The workflow appears in the GitHub Actions tab after push (manual verification).
- `npm run build` unaffected (workflows are not compiled).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-ci-sdk-php`. Open PR titled
`ci(sdk-php): phpunit workflow`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. Dependabot — supply-chain hygiene across all six package ecosystems
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(deps): dependabot config for all package ecosystems',
$$Create `.github/dependabot.yml` so GitHub Dependabot opens grouped weekly
PRs for each of ZettaPay's six package ecosystems plus the GitHub Actions
workflows themselves. Today there is no automated dependency-update lane —
manual `npm audit` is the only signal, and the repo has six published or
publishable SDKs (TS, embed, widget, Rust, Python, Go, PHP) plus the
Vercel serverless surface. Premissa 19 (pre-mainnet $50k bug-bounty) +
Premissa 22 (security-headers / supply-chain discipline) both point at
this gap.

Scope (1 new file, ~80 LOC):

1. Create `.github/dependabot.yml` with `version: 2` and one entry per
   package ecosystem actually present in the repo. The ecosystems to cover:

   | Ecosystem | Directory | Notes |
   |-----------|-----------|-------|
   | `npm` | `/` | Root `package.json` |
   | `npm` | `/packages/sdk` | Public SDK |
   | `npm` | `/packages/embed` | Public embed |
   | `npm` | `/packages/widget` | Public widget |
   | `cargo` | `/packages/sdk-rust` | Rust SDK |
   | `pip` | `/packages/sdk-python` | Python SDK (uses pyproject.toml) |
   | `gomod` | `/packages/sdk-go` | Go SDK |
   | `composer` | `/packages/sdk-php` | PHP SDK |
   | `github-actions` | `/` | Workflow action versions |

2. Required fields per entry:
   - `schedule.interval: "weekly"` + `schedule.day: "monday"`.
   - `open-pull-requests-limit: 5` (prevents PR floods on first run).
   - `groups:` — group minor + patch into one PR per ecosystem.
     Example group block:
     ```yaml
     groups:
       minor-and-patch:
         update-types:
           - "minor"
           - "patch"
     ```
   - `labels: ["dependencies", "<ecosystem>"]` (e.g. `["dependencies", "npm-root"]`).
   - `commit-message.prefix: "chore(deps)"` to match repo commit-message
     convention (existing commits use Conventional Commits — see git log).

3. Do NOT enable `auto-merge` in the dependabot config itself. Auto-merge
   for low-risk updates is a separate repo-admin mission once the maintainer
   has reviewed the first wave of PRs.

4. Do NOT enable `versioning-strategy: increase` for the SDKs — Dependabot's
   default (`auto`) is correct; SDKs ship semver-pinned dependencies.

5. Cargo lock is gitignored (`.gitignore` excludes `**/Cargo.lock` at line
   ~16). Dependabot `cargo` ecosystem works on `Cargo.toml` alone in that
   case — no additional config needed. Same applies to `pip` (no lock file
   in `packages/sdk-python/`).

6. Do NOT add a `renovate.json` alongside — pick one. Dependabot is the
   default for GitHub-native repos and requires zero additional GitHub App
   install. Renovate can replace Dependabot in a separate mission if the
   maintainer prefers it.

Validation:
- `python -c "import yaml; cfg=yaml.safe_load(open('.github/dependabot.yml')); assert cfg['version']==2; assert len(cfg['updates'])>=9"`
  exits 0. (Nine entries: 4 npm + 1 cargo + 1 pip + 1 gomod + 1 composer +
  1 github-actions.)
- `grep -c '^  - package-ecosystem:' .github/dependabot.yml` returns >= 9.
- `grep -c 'interval: "weekly"' .github/dependabot.yml` returns >= 9.
- `grep -c 'minor-and-patch:' .github/dependabot.yml` returns >= 9.
- After merge, Dependabot's "Last checked" timestamp updates on the repo's
  Insights → Dependency graph → Dependabot tab (manual verification).
- `npm run build` unaffected (dependabot.yml is GitHub-side config).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-dependabot`. Open PR titled
`chore(deps): dependabot config for all package ecosystems`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. CI(embed): gzip size budget gate — block embed bloat
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci(embed): gzip size budget gate',
$$Create `.github/workflows/embed-size.yml` so every PR that touches
`packages/embed/**` builds the embed and **fails** the workflow when
`packages/embed/dist/embed.js` exceeds **8 KB gzipped**. Today
`packages/embed/scripts/build.mjs` prints the gzipped size at every build
(see the `console.log` line that emits `${gzipKb(iifePath)} kb gzip`) but
nothing fails when the budget is exceeded. Current size is ~5 KB gzipped
per the package README claim; the 8 KB ceiling gives ~60% headroom while
still catching real regressions.

Premissa 17 (bundle <200KB gzip site-wide) is much looser than the embed's
own ~5KB internal target — and the embed is the only artifact small enough
to be a real regression risk if we silently add 2KB per quarter.

Scope (1 new file, ~50 LOC):

1. Create `.github/workflows/embed-size.yml`:
   ```yaml
   name: embed-size

   on:
     push:
       branches: [main]
       paths:
         - 'packages/embed/**'
         - '.github/workflows/embed-size.yml'
     pull_request:
       paths:
         - 'packages/embed/**'
         - '.github/workflows/embed-size.yml'

   jobs:
     size:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: '20'
             cache: 'npm'
         - name: Install root deps
           run: npm install --include=dev --ignore-scripts
         - name: Build embed
           working-directory: packages/embed
           run: npm run build
         - name: Assert gzip budget
           working-directory: packages/embed
           shell: bash
           run: |
             set -euo pipefail
             BUDGET_BYTES=8192   # 8 KB
             SIZE=$(gzip -9c dist/embed.js | wc -c)
             echo "embed.js gzip size: ${SIZE} bytes (budget ${BUDGET_BYTES})"
             if [ "$SIZE" -gt "$BUDGET_BYTES" ]; then
               echo "::error::embed.js exceeds ${BUDGET_BYTES}-byte gzip budget (${SIZE} bytes)"
               exit 1
             fi
   ```
2. Budget is `8192` bytes (8 KB) — current size ~5 KB per README, ~60%
   headroom is enough to catch real regressions without rejecting normal
   feature growth. Do NOT pick 5 KB (too tight, will block first legitimate
   feature) or 16 KB (too loose, defeats the purpose).
3. Use `npm install --include=dev` (per worker memory
   `feedback_npm_install.md` — Vercel/CI environments default `NODE_ENV=production`
   and skip devDependencies otherwise; esbuild is a devDependency).
4. Use `--ignore-scripts` to skip the root postinstall (if any) — embed
   build is self-contained in `packages/embed/scripts/build.mjs`.
5. Do NOT modify `packages/embed/scripts/build.mjs` itself — the build
   script keeps its informational `console.log`. The CI workflow adds the
   enforcement layer. (If `build.mjs` ever grows its own assertion that
   replicates this gate, the workflow can be deleted in a follow-up.)
6. Do NOT add a parallel gate for `embed.esm.js` — the ESM variant is
   un-minified for npm consumers, so gzip-size is not the right metric
   there. IIFE-only.
7. Do NOT add a gate for `packages/widget/dist/*` in the same workflow —
   widget has a different budget (currently larger). One workflow per
   bundle keeps failures attributable.

Validation:
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/embed-size.yml'))"` exits 0.
- `grep -c 'gzip -9c' .github/workflows/embed-size.yml` returns 1.
- `grep -c 'BUDGET_BYTES=8192' .github/workflows/embed-size.yml` returns 1.
- `grep -c 'exit 1' .github/workflows/embed-size.yml` returns 1.
- Locally: `cd packages/embed && npm install --include=dev && npm run build && gzip -9c dist/embed.js | wc -c`
  prints a number < 8192.
- The workflow appears in the GitHub Actions tab after push (manual verification).
- `npm run build` (root) unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-ci-embed-size-gate`. Open PR titled
`ci(embed): gzip size budget gate`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', '1986ee3d',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/1986ee3d-backlog-refill.md',
     'companion_sql', 'docs/discovery/1986ee3d-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk-go: webhook signature verifier',
       'sdk-php: webhook signature verifier',
       'ci(sdk-php): phpunit workflow',
       'chore(deps): dependabot config for all package ecosystems',
       'ci(embed): gzip size budget gate'
     ),
     'themes', jsonb_build_array(
       'polyglot-sdk-webhook-parity',
       'per-sdk-ci-parity',
       'supply-chain-hygiene',
       'bundle-size-regression-gate'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk-go (additive, std-lib only, gated by existing sdk-go.yml)',
       'packages/sdk-php (additive, no composer.json change, gated by new sdk-php.yml)',
       '.github/workflows (CI config, non-compile)',
       '.github/dependabot.yml (GitHub-side config, non-compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors of existing source',
       'framework adapters (Gin/Echo/PSR-15) — verifier surface only',
       'publish-to-registry jobs (Packagist/crates.io/PyPI) — separate missions'
     ),
     'known_followups', jsonb_build_array(
       'audit/HALL_OF_FAME.md placeholder (referenced by security.txt mission queued in 03cf9a17)',
       'security-pgp.asc placeholder (same reference chain)',
       'sdk-php-publish.yml (Packagist release lane)',
       'sdk-rust-publish.yml (crates.io release lane)',
       'sdk-python-publish.yml (PyPI release lane)',
       'phpstan + php-cs-fixer lint workflow (after phpunit gate lands)'
     )
   ));

COMMIT;
