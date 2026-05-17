-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: c08a7f17
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/c08a7f17-backlog-refill.md
-- All 5 picks are single-file, single-objective, additive, and outside the
-- chronic-broken packages/api compile lane. None touch wallet code.
--
-- Themes covered:
--   1. Per-SDK LICENSE parity for the three remaining SDKs (python, go, php)
--      — sdk-rust shipped its LICENSE in pass 07b1ae9c (PR #261); the prior
--      reviewer explicitly split the remaining three as separate single-file
--      missions ordered by publication priority. This pass picks all three up.
--   2. Per-SDK examples/webhook.* parity — the sdk-rust and sdk-python
--      source webhook verifiers landed in #235/#236 (the verifier itself),
--      but neither crate has an examples/webhook.* showing the end-to-end
--      verification flow. Both crates already have examples/quickstart.*;
--      this pass adds the parallel webhook examples mirroring that shape.
--
-- Repeat-rejection themes deliberately AVOIDED in this refill (each rejected
-- 2+ times by prior reviewers): CHANGELOG.md (release-ops decision),
-- CODEOWNERS (owner/team decision), FUNDING.yml (sponsor target bikeshed),
-- CODE_OF_CONDUCT.md (enforcement contact decision), public/manifest.json
-- PWA shell (needs coordinated service worker), public/favicon.* (needs
-- brand design decision), aggressive CSP / HSTS / X-Frame-Options.
--
-- Per-SDK CHANGELOG and packages/sdk-go/examples/webhook.go +
-- packages/sdk-php/examples/webhook.php deferred because the underlying
-- sdk-go and sdk-php webhook verifiers themselves are still queued (in
-- 1986ee3d) and not yet shipped — example must follow source.
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-python — ship MIT LICENSE file at package root (PyPI surfaces it inline)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(sdk-python): LICENSE at package root (PyPI)',
$$Add `packages/sdk-python/LICENSE` containing the MIT license text matching the root `LICENSE` of this repository. Today the Python SDK only declares `license = { text = "MIT" }` in `pyproject.toml`; the package root has no LICENSE file. Prior refill `07b1ae9c` shipped the sdk-rust LICENSE; the prior reviewer's rationale explicitly split sdk-python / sdk-go / sdk-php as separate single-file missions ordered by publication priority. This is sdk-python.

Why this matters:
- PyPI's project page renders the LICENSE file inline (under the "License" sidebar entry) when one is present in the source distribution; without it, PyPI shows only the SPDX identifier from `pyproject.toml`.
- setuptools' `[project]` metadata supports `license-files = ["LICENSE*"]` for modern PEPs, but the file itself must exist on disk.
- Some enterprise allowlists (Sonatype, JFrog) refuse to mirror packages without a LICENSE on disk.

Premissa 31 ("Open source: protocol spec + SDKs MIT") + Premissa 23 (SDK-first DX).

Scope (1 new file, ~21 LOC — verbatim MIT text):

1. Create `packages/sdk-python/LICENSE` containing the EXACT same MIT text as the repository root `LICENSE` (run `diff packages/sdk-python/LICENSE LICENSE` to verify zero diff). Copy verbatim — do NOT modify the copyright holder line.
2. Do NOT modify `packages/sdk-python/pyproject.toml`. The `license = { text = "MIT" }` field is already correct; adding `license-files = ["LICENSE"]` is a separate setuptools-modernization mission (deferred).
3. Do NOT touch `packages/sdk-go/` or `packages/sdk-php/` — those are separate missions.
4. Do NOT create a `LICENSE.txt` or `LICENSE.md` variant — PyPI / pip / setuptools all check for `LICENSE` (no extension) first.

Validation:
- `diff packages/sdk-python/LICENSE LICENSE` returns no diff (file is verbatim copy).
- `wc -l packages/sdk-python/LICENSE` matches `wc -l LICENSE` (same line count).
- `npm run build` unaffected — the file lives outside any TypeScript include path.
- Wallet-less hard rule N/A — LICENSE file is plain text.
- Brand discipline: no Claude/Anthropic mentions in the file or commit. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-python-license`. Open PR titled `chore(sdk-python): ship LICENSE at package root (MIT)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. sdk-go — ship MIT LICENSE file at module root (pkg.go.dev surfaces it)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(sdk-go): LICENSE at module root (pkg.go.dev)',
$$Add `packages/sdk-go/LICENSE` containing the MIT license text matching the root `LICENSE` of this repository. Today the Go SDK module has `client.go`, `errors.go`, `retry.go`, `types.go`, `client_test.go`, `go.mod`, `README.md`, `doc.go` — but NO LICENSE file at module root.

Why this matters:
- pkg.go.dev refuses to render a module's documentation page if it cannot detect a license at the module root: the documentation page shows a "License: Unknown" warning and the module is de-prioritized in pkg.go.dev's search ranking.
- The Go ecosystem's `licensecheck` tool (used by Google's Open Source compliance scanner and required by many enterprise allowlists) depends on a `LICENSE` file at the module root.
- `go list -m -json` does not have a license field; the LICENSE file IS the canonical signal.

Premissa 31 + Premissa 23.

Scope (1 new file, ~21 LOC — verbatim MIT text):

1. Create `packages/sdk-go/LICENSE` containing the EXACT same MIT text as the repository root `LICENSE` (run `diff packages/sdk-go/LICENSE LICENSE` to verify zero diff). Copy verbatim.
2. Do NOT modify `packages/sdk-go/go.mod` — Go modules do not have a license declaration field; the LICENSE file at module root is the canonical signal.
3. Do NOT add LICENSE-header comment blocks at the top of each `.go` file — that's a separate convention (golang/x/tools `licensecheck` does check headers but the module-root LICENSE is the primary signal pkg.go.dev consumes).
4. Do NOT touch `packages/sdk-python/` or `packages/sdk-php/`.

Validation:
- `diff packages/sdk-go/LICENSE LICENSE` returns no diff.
- `cd packages/sdk-go && go vet ./...` (if Go toolchain available) is unaffected — LICENSE is not compiled.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-go-license`. Open PR titled `chore(sdk-go): ship LICENSE at module root (MIT)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. sdk-php — ship MIT LICENSE file at package root (Packagist surfaces it)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(sdk-php): LICENSE at package root (Packagist)',
$$Add `packages/sdk-php/LICENSE` containing the MIT license text matching the root `LICENSE` of this repository. Today the PHP SDK has `composer.json`, `README.md`, `phpunit.xml.dist`, `src/`, `tests/`, `.gitignore` — but NO LICENSE file. `composer.json` declares `"license": "MIT"` only.

Why this matters:
- Packagist's package page renders the LICENSE file inline (when present in the source distribution), and "Has LICENSE file: ✓" appears in the package metadata.
- Some enterprise Composer mirrors (Repman, Private Packagist) refuse to mirror packages with `license` in `composer.json` but no `LICENSE` on disk.
- Composer's `composer licenses` command in downstream projects reads the LICENSE file directly when generating license-compliance reports.

Premissa 31 + Premissa 23.

Scope (1 new file, ~21 LOC — verbatim MIT text):

1. Create `packages/sdk-php/LICENSE` containing the EXACT same MIT text as the repository root `LICENSE` (run `diff packages/sdk-php/LICENSE LICENSE` to verify zero diff). Copy verbatim.
2. Do NOT modify `packages/sdk-php/composer.json`. The `"license": "MIT"` field is already correct; the file at root + the composer.json field together satisfy Composer's discovery.
3. Do NOT touch `packages/sdk-python/` or `packages/sdk-go/`.
4. Do NOT add a `LICENSE.md` or `LICENSE.txt` variant — Composer / Packagist look for `LICENSE` (no extension) first.

Validation:
- `diff packages/sdk-php/LICENSE LICENSE` returns no diff.
- `cd packages/sdk-php && composer validate --strict` (if Composer available) emits no new warnings.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-license`. Open PR titled `chore(sdk-php): ship LICENSE at package root (MIT)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. sdk-rust — examples/webhook.rs end-to-end demo (parity with quickstart.rs)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(sdk-rust): examples/webhook.rs end-to-end demo',
$$Add `packages/sdk-rust/examples/webhook.rs` — a runnable example demonstrating the sign → verify round-trip using the public webhook API in `packages/sdk-rust/src/webhook.rs` (228 LOC). Today the crate has `examples/quickstart.rs` (covering the HTTP client) but no parallel example for the webhook-signature verification flow that merchants need to wire up FIRST when accepting payments.

Premissa 9 (Webhooks Stripe-grade — signature verification is THE canonical reliability primitive) + Premissa 23 (SDK-first DX) + Premissa 25 (DevRel + open SDK > paid marketing).

Public surface to exercise (read from `packages/sdk-rust/src/webhook.rs` before writing):
- `sign_payload(secret: &str, payload: &str, timestamp_ms: i64) -> String` (line 185)
- `parse_webhook(opts: VerifyOptions<'_>) -> ParseWebhookResult` (line 197)
- `VerifyOptions<'a>` struct (line 163)
- `ParsedWebhook` struct (line 83), `ParseWebhookResult` enum (line 139), `WebhookError` enum (line 99)
- `is_valid()`, `into_result()` methods (lines 156, 148)

Scope (1 new file, ~80-100 LOC):

1. Create `packages/sdk-rust/examples/webhook.rs`.
2. Header doc-comment mirrors `examples/quickstart.rs` shape — module-level `//!` block with a "End-to-end ZettaPay Rust SDK webhook verification" title, `## Run` section with `cargo run --example webhook`, and a one-line scope statement.
3. Demonstrate three concrete cases in `main()`:
   - **Sign + verify round-trip** — call `sign_payload(secret, payload, timestamp_ms_now)`, build `VerifyOptions` with that signature + timestamp + payload, call `parse_webhook(opts)`, assert `.is_valid()` returns true and `.into_result()` is `Ok(ParsedWebhook { .. })`. Print `✓ sign/verify round-trip ok`.
   - **Expired timestamp** — same payload + signature but the timestamp is 6 minutes in the past (>= 300_000 ms tolerance window), assert `into_result()` returns `Err(WebhookError::Expired)` (verify the actual variant name by reading `src/webhook.rs` line 99). Print `✓ expired timestamp rejected`.
   - **Bad signature** — tampered payload (append a byte) but ORIGINAL signature, assert `Err(WebhookError::InvalidSignature)`. Print `✓ tampered payload rejected`.
4. Use only public exports from the `zettapay` crate (`use zettapay::webhook::{...};` — verify the path matches `src/lib.rs` re-exports before writing).
5. The example MUST be runnable via `cargo run --example webhook` from `packages/sdk-rust/`. No external network calls — entirely in-process.
6. Do NOT modify `src/webhook.rs` — examples only.
7. Do NOT add new dev-dependencies. Use only `std::time::{SystemTime, UNIX_EPOCH}` for timestamp generation; no `chrono` / `time` crate.

Validation:
- `cargo build --example webhook --manifest-path packages/sdk-rust/Cargo.toml` (if Rust toolchain available) compiles cleanly.
- `cargo run --example webhook --manifest-path packages/sdk-rust/Cargo.toml` exits 0 and prints exactly three `✓` lines.
- `npm run build` unaffected — Rust files outside TypeScript build.
- Wallet-less hard rule N/A — webhook verification is HMAC, no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-rust-webhook-example`. Open PR titled `docs(sdk-rust): add examples/webhook.rs end-to-end verification demo`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. sdk-python — examples/webhook.py end-to-end demo (parity with quickstart.py)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(sdk-python): examples/webhook.py end-to-end demo',
$$Add `packages/sdk-python/examples/webhook.py` — a runnable example demonstrating the sign → verify round-trip using the public webhook API in `packages/sdk-python/zettapay/webhook.py`. Today the package has `examples/quickstart.py` (covering the HTTP client) but no parallel example for the webhook-signature verification flow.

Premissa 9 + Premissa 23 + Premissa 25 (same rationale as the sibling sdk-rust webhook example).

Public surface to exercise (read from `packages/sdk-python/zettapay/webhook.py` + `__init__.py` before writing):
- `parse_webhook(...)` (defined at line 102 of webhook.py — read signature for exact parameter names)
- `ParsedWebhook` dataclass (line 74)
- `ParseWebhookResult` dataclass (line 90)
- Whatever error type the parse function returns (read the source — likely `WebhookError` or sentinel-on-`ParseWebhookResult`)
- IMPORT PATHS must match what `packages/sdk-python/zettapay/__init__.py` re-exports; verify before importing (`from zettapay import parse_webhook, ParsedWebhook` may or may not work depending on `__init__.py` — fall back to `from zettapay.webhook import ...` if not re-exported).

Scope (1 new file, ~80-100 LOC):

1. Create `packages/sdk-python/examples/webhook.py`.
2. Header docstring mirrors `examples/quickstart.py` shape — module-level `"""..."""` with "End-to-end ZettaPay Python SDK webhook verification" + `Run:` block + scope statement.
3. Demonstrate three concrete cases (same trio as the sibling sdk-rust example):
   - **Sign + verify round-trip** — compute HMAC-SHA256 over the canonical signed string (read `packages/sdk-python/zettapay/webhook.py` to confirm the format — likely `{timestamp_ms}.{body}` or similar), hex-encode, build the headers dict per what `parse_webhook` expects, call `parse_webhook(...)`, assert the result is valid via `.into_result()` or equivalent. Print `✓ sign/verify round-trip ok`.
   - **Expired timestamp** — same payload + signature but timestamp >= 6 minutes in the past, assert the error variant matches what `webhook.py` returns for expiry. Print `✓ expired timestamp rejected`.
   - **Bad signature** — tampered body, assert error. Print `✓ tampered payload rejected`.
4. Use only public exports from the `zettapay` package. Inspect `zettapay/__init__.py` BEFORE writing import statements; fall back to module-direct imports if a symbol is not re-exported at the package root.
5. Provide an `if __name__ == "__main__":` block that runs all three cases sequentially.
6. Do NOT modify `zettapay/webhook.py` — examples only.
7. Do NOT add new dependencies — `pyproject.toml` declares `dependencies = []` (zero runtime deps) and the example must respect that. Use only `hmac`, `hashlib`, `time` from the standard library.

Validation:
- `cd packages/sdk-python && python examples/webhook.py` (if Python 3.9+ available) prints three `✓` lines and exits 0.
- `python -c "import ast; ast.parse(open('packages/sdk-python/examples/webhook.py').read())"` parses cleanly (syntax-only smoke).
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-python-webhook-example`. Open PR titled `docs(sdk-python): add examples/webhook.py end-to-end verification demo`.$$,
   'execution', 'pending', 'auto-regen', 2);

COMMIT;

-- ---------------------------------------------------------------------------
-- Audit-journal write — record the auto-regen execution for downstream audit.
-- The payload lists the human-readable mission names (mission IDs are
-- assigned by Postgres on INSERT; the orchestrator can backfill them by
-- joining on (workspace_id, name, source) after applying the missions).
-- ---------------------------------------------------------------------------

INSERT INTO fabric_audit_journal
  (event_type, payload)
VALUES
  ('auto_regen_executed',
   jsonb_build_object(
     'workspace_id', 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
     'mission_uuid_prefix', 'c08a7f17',
     'generated_at', '2026-05-17',
     'companion_doc', 'docs/discovery/c08a7f17-backlog-refill.md',
     'companion_sql', 'docs/discovery/c08a7f17-backlog-refill.sql',
     'mission_names', jsonb_build_array(
       'chore(sdk-python): LICENSE at package root (PyPI)',
       'chore(sdk-go): LICENSE at module root (pkg.go.dev)',
       'chore(sdk-php): LICENSE at package root (Packagist)',
       'docs(sdk-rust): examples/webhook.rs end-to-end demo',
       'docs(sdk-python): examples/webhook.py end-to-end demo'
     ),
     'themes', jsonb_build_array(
       'per-SDK-LICENSE-parity (python + go + php — completes the polyglot drain after sdk-rust shipped in #261)',
       'per-SDK-webhook-example-parity (rust + python, both already have quickstart but no webhook example)'
     ),
     'avoided_repeat_rejections', jsonb_build_array(
       'CHANGELOG.md (release-ops decision)',
       'CODEOWNERS (owner/team decision)',
       'FUNDING.yml (sponsor target bikeshed)',
       'CODE_OF_CONDUCT.md (enforcement contact decision)',
       'public/manifest.json PWA shell (needs coordinated service worker)',
       'public/favicon.* (needs brand design decision)',
       'aggressive CSP / HSTS / X-Frame-Options (page-by-page audit needed)'
     ),
     'deferred_until_dependency_ships', jsonb_build_array(
       'packages/sdk-go/examples/webhook.go (sdk-go webhook verifier itself queued in 1986ee3d, not yet shipped)',
       'packages/sdk-php/examples/webhook.php (sdk-php webhook verifier itself queued in 1986ee3d, not yet shipped)'
     ),
     'prior_refill_chain', jsonb_build_array(
       '#261 (07b1ae9c)', '#260 (03cf9a17)', '#259 (e365137f)', '#258 (66b549af)',
       '#257 (d5806497)', '#254 (bf6837e4)', '#253 (9db4cb78)', '#252 (a82d92db)',
       '#251 (1986ee3d)', '#245 (2e05f052)', '#244 (4f79ec06)', '#242 (69cdcbce)',
       '#231 (fba46358)'
     )
   ));
