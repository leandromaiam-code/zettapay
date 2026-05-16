-- Auto-discovery backlog refill — generated 2026-05-16
-- Source mission UUID prefix: fba46358
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/fba46358-backlog-refill.md
-- The mission worker could not reach Supabase MCP directly; these statements
-- are the canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are idempotent against (workspace_id, name) — re-running is
-- safe if mission rows are de-duplicated upstream by name.

BEGIN;

-- 1. Python SDK webhook verifier
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'SDK-Python: webhook signature verifier',
$$Add a `parse_webhook` helper to `packages/sdk-python/zettapay/webhook.py` (new file) that mirrors the TypeScript SDK reference implementation in `packages/sdk/src/webhook.ts`.

Scope (single module + tests):

1. Create `packages/sdk-python/zettapay/webhook.py` exposing:
   - Constants `SIGNATURE_HEADER`, `TIMESTAMP_HEADER`, `EVENT_ID_HEADER`, `ATTEMPT_HEADER` matching the canonical header names (`X-ZettaPay-*`).
   - Dataclasses `ParsedWebhook` and `ParseWebhookResult` (an `ok | failure` union — use a discriminated dataclass pair).
   - `parse_webhook(body: bytes | str, headers: Mapping[str, str], secret: str, *, tolerance_seconds: int = 300, now: Callable[[], int] | None = None) -> ParseWebhookResult` that HMAC-SHA256s the canonical string `f"{timestamp}.{body}"` and compares against the header via `hmac.compare_digest`.
   - Failure reasons mirror the TS union exactly: `missing_signature`, `bad_signature`, `stale_timestamp`, `missing_timestamp`, `missing_event_id`, `bad_body`.

2. Re-export from `packages/sdk-python/zettapay/__init__.py`.

3. Tests in `packages/sdk-python/tests/test_webhook.py` covering: happy path, bad signature, stale timestamp (past tolerance), missing required header, non-utf8 body, passthrough of bytes vs str body.

Validation:
- `cd packages/sdk-python && python -m pytest tests/test_webhook.py -q` passes locally.
- Zero new runtime dependencies (use stdlib `hmac`, `hashlib`, `dataclasses`).
- Wallet-less hard rule: no `wallet.connect()` / `window.solana` references. This is server-side webhook handling — trivially compliant.
- Brand discipline: no Claude/Anthropic mentions in commits or comments. Co-author tag: Veridian Fabric.

Branch: `auto/<uuid>-sdk-python-webhook-verifier`. Open PR titled `feat(sdk-python): webhook signature verifier (parity with TS SDK)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. Rust SDK webhook verifier
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'SDK-Rust: webhook signature verifier',
$$Add a `webhook` module to `packages/sdk-rust/src/webhook.rs` (new file) that mirrors `packages/sdk/src/webhook.ts` parse-and-verify behaviour.

Scope (single module + tests):

1. Create `packages/sdk-rust/src/webhook.rs` exposing:
   - Header name constants matching `X-ZettaPay-Signature`, `X-ZettaPay-Timestamp`, `X-ZettaPay-Event-Id`, `X-ZettaPay-Attempt`.
   - `pub struct ParsedWebhook<T>` (generic over the deserialised payload).
   - `pub enum WebhookFailureReason` mirroring the TS union: `MissingSignature`, `BadSignature`, `StaleTimestamp`, `MissingTimestamp`, `MissingEventId`, `BadBody`.
   - `pub fn parse_webhook<T: DeserializeOwned>(body: &[u8], headers: &HeaderMap, secret: &str, tolerance: Duration) -> Result<ParsedWebhook<T>, WebhookFailureReason>` using the `hmac` + `sha2` crates with constant-time compare.

2. Add `pub mod webhook; pub use webhook::{parse_webhook, ParsedWebhook, WebhookFailureReason, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER, ATTEMPT_HEADER};` to `packages/sdk-rust/src/lib.rs`.

3. Add `hmac = "0.12"` and `sha2 = "0.10"` (or current latest) to `packages/sdk-rust/Cargo.toml` only if not already present (both are common transitive deps via `solana-sdk`; check first).

4. Tests in `packages/sdk-rust/tests/webhook.rs` covering the same matrix as the Python mission (happy path, bad sig, stale ts, missing headers, malformed body).

Validation:
- `cd packages/sdk-rust && cargo test --test webhook` passes.
- `cargo build --release` succeeds with no new warnings.
- Wallet-less hard rule compliant (server-side helper).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-rust-webhook-verifier`. Open PR titled `feat(sdk-rust): webhook signature verifier (parity with TS SDK)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. TS SDK errors.ts tests
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'SDK: unit tests for errors.ts (ZettaPayError + fromAxiosError)',
$$Add `packages/sdk/test/errors.test.ts` — single new vitest file — covering the 58 lines of `packages/sdk/src/errors.ts`. The module is pure logic (no I/O), so mocking is limited to constructing fake `AxiosError` objects with `isAxiosError: true`.

Required cases (at minimum eight `it()` blocks):

1. `fromAxiosError` returns the same `ZettaPayError` instance when passed one (passthrough).
2. Axios error with a well-formed `ApiErrorBody` response yields `code`, `message`, `status`, `details` populated from the body.
3. Axios error with an HTTP status but no `ApiErrorBody` falls back to `code: 'http_error'` and uses `axiosErr.message`.
4. Axios network error (no `response`) maps to `code: 'network_error'` (or `axiosErr.code` if present, e.g. `ECONNABORTED`).
5. Non-axios `Error` instance is wrapped with `code: 'unknown'` (or whatever the canonical fallback is — read the file).
6. `ZettaPayError` exposes `cause` for chained debugging.
7. `is_code` / `is_status` helpers — happy paths and a negative path each. (Verify exact names; the Python SDK re-exports `is_code`/`is_status` so TS likely has `isCode`/`isStatus`.)
8. `isApiErrorBody` rejects malformed inputs (null, wrong shape, missing `code`).

Validation:
- `cd packages/sdk && npx vitest run test/errors.test.ts` passes.
- Coverage report for `src/errors.ts` reaches 100% line + 90%+ branch (run `npx vitest run --coverage` and assert in PR description).
- No changes to `src/errors.ts` itself. Test-only PR.
- Wallet-less hard rule N/A (no wallet code).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-errors-tests`. Open PR titled `test(sdk): unit tests for errors.ts (ZettaPayError + fromAxiosError)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. .env.example LOG_PRETTY doc
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs: document LOG_PRETTY env var in .env.example',
$$Add a documented entry for `LOG_PRETTY` to `.env.example`. The variable is read at `packages/api/src/lib/logger.ts:7` (`const pretty = process.env.LOG_PRETTY === "1";`) but is completely undocumented — new contributors hit cryptic JSON logs locally with no hint.

Scope (single file, 1-3 lines inserted):

1. Add the following block to `.env.example`, grouped near other dev-only / observability vars (place it after the existing `NODE_ENV=development` block at the top):

```
# Set to "1" to switch the API server's pino logger into pretty-print mode for
# local development. Leave unset in production for structured JSON logs
# (Premissa 12 — structured logs + correlation IDs).
LOG_PRETTY=
```

Validation:
- `grep -n LOG_PRETTY .env.example` returns the new entry.
- `git diff --stat` shows exactly one file changed, < 5 lines added, zero lines removed.
- Build N/A — `.env.example` is not compiled.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-env-log-pretty`. Open PR titled `docs: document LOG_PRETTY env var (used by pino logger)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. BUG_BOUNTY.md devnet listing reference
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'audit/BUG_BOUNTY.md: reference live Immunefi devnet listing',
$$Update `audit/BUG_BOUNTY.md` to reflect the Immunefi devnet listing that shipped in PR #196 (Z28.2, merged 2026-05-15). The doc currently reads as if no listing exists yet, sending bounty hunters into limbo.

Scope (single file, two surgical edits):

1. Around line 10 — replace the "once Z22.1 cuts the mainnet" sentence with a paragraph that:
   - States the devnet program is **live** today and links to `audit/immunefi/` for the submission status log.
   - Notes the mainnet bounty pool activates on the Z22.1 cutover (keep that detail — it's still true for the $50k mainnet pool).
   - Cites PR #196 in a footnote-style trailing parenthesis: `(devnet listing shipped 2026-05-15, see PR #196).`

2. Around line 108 — add a new row to the change-log table:
   ```
   | 2026-05-15 | Devnet program listed publicly on Immunefi (PR #196). Mainnet pool row below remains unset pending Z22.1 cutover. |
   ```
   Keep the existing `_(unset — set on Z22.1 cutover)_` row beneath the new one.

Validation:
- `grep -n "PR #196" audit/BUG_BOUNTY.md` returns two hits (intro paragraph + change-log row).
- The Z22.1 mainnet-cutover language is preserved for the mainnet pool — the devnet edit must not retroactively claim the mainnet pool is live.
- `npm run build` unaffected (doc-only).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-bug-bounty-devnet-ref`. Open PR titled `docs(audit): reference live Immunefi devnet listing in BUG_BOUNTY.md`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit journal entry
INSERT INTO fabric_audit_journal (event_type, payload)
VALUES
  ('auto_regen_executed',
   jsonb_build_object(
     'workspace_id', 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
     'source_mission_uuid_prefix', 'fba46358',
     'branch', 'auto/fba46358--auto-discovery-identificar-pr-ximos-5-g',
     'generated_at', '2026-05-16',
     'missions_created', jsonb_build_array(
       'SDK-Python: webhook signature verifier',
       'SDK-Rust: webhook signature verifier',
       'SDK: unit tests for errors.ts (ZettaPayError + fromAxiosError)',
       'docs: document LOG_PRETTY env var in .env.example',
       'audit/BUG_BOUNTY.md: reference live Immunefi devnet listing'
     ),
     'rejected_candidates', jsonb_build_object(
       'packages_api_build_repair', 'Out-of-scope: multi-file fix in chronic-broken lane (src/db/payments.ts, src/server.ts, src/services/payments.ts). Flagged for human triage in companion .md.',
       'z29_4_zombie_sentinel_chain', 'Orchestrator-side issue (9+ open sentinels for #186); not a code mission.'
     ),
     'notes', 'Direct fabric_squad_missions INSERT could not be executed: Supabase MCP unavailable to worker. Orchestrator should apply this SQL post-merge or human operator runs it with service-role key.'
   ));

COMMIT;
