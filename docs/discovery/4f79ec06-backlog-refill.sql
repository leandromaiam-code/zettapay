-- Auto-discovery backlog refill — generated 2026-05-16
-- Source mission UUID prefix: 4f79ec06
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/4f79ec06-backlog-refill.md
-- All 5 picks target the SDK public-API + Vercel serverless safe lane + vercel.json.
-- None of them touch packages/api (chronic-broken compile lane) or any wallet code.
--
-- The mission worker could not reach Supabase MCP directly (see worker memory
-- feedback_supabase_mcp_unavailable.md); these statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- should apply on merge.
--
-- All inserts are idempotent against (workspace_id, name) — re-running is
-- safe if mission rows are de-duplicated upstream by name.

BEGIN;

-- 1. Python SDK — re-export parse_webhook + WebhookError from package root
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-python: re-export parse_webhook + WebhookError at package root',
$$Wire `parse_webhook` and `WebhookError` (shipped in PR #235) into the public Python SDK API so `from zettapay import parse_webhook, WebhookError` works and `from zettapay import *` includes them. Today they live only under the `zettapay.webhook` submodule with no top-level import. TypeScript SDK exports `parseWebhook` from the package root; Python parity is the goal.

Scope (1 file, ~3 lines added):

1. In `packages/sdk-python/zettapay/__init__.py`:
   - Add a new import line near the existing imports (after line 30, before line 31):
     ```python
     from .webhook import WebhookError, parse_webhook
     ```
   - In the `__all__` list (currently lines 43–59), insert `"WebhookError"` and `"parse_webhook"` in alphabetical position. Final `__all__` should contain 16 items, sorted.

2. Do **not** rename, restructure, or alter `zettapay/webhook.py` itself — it stays the source of truth. This mission is purely the package-root wiring.

3. Do **not** touch `packages/sdk-python/README.md`, `setup.py`, or `pyproject.toml`. Docs follow-up is a separate mission.

Validation:
- `grep -E 'parse_webhook|WebhookError' packages/sdk-python/zettapay/__init__.py | wc -l` returns >= 3 (one import line + two `__all__` entries).
- `cd packages/sdk-python && python -c "from zettapay import parse_webhook, WebhookError; print('ok')"` prints `ok`.
- `cd packages/sdk-python && python -c "import zettapay; assert 'parse_webhook' in zettapay.__all__ and 'WebhookError' in zettapay.__all__; print('ok')"` prints `ok`.
- If a tests directory exists, run `cd packages/sdk-python && python -m pytest tests/ -q` and confirm green (no test changes expected — this is a pure re-export).
- `npm run build` unaffected (Python SDK has its own toolchain).
- Wallet-less hard rule N/A — no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-python-webhook-reexport`. Open PR titled `feat(sdk-python): re-export parse_webhook + WebhookError at package root`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. Rust SDK — re-export webhook::* at crate root
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-rust: re-export webhook public symbols at crate root',
$$Add a `pub use webhook::{parse_webhook, ParsedWebhook, WebhookError, DEFAULT_TOLERANCE_SEC};` line to `packages/sdk-rust/src/lib.rs` so the webhook helpers shipped in PR #236 are reachable as `zettapay::parse_webhook` instead of `zettapay::webhook::parse_webhook`. Idiomatic Rust crates re-export their public API at the crate root (compare `serde::*`, `tokio::*`, `reqwest::*`).

Scope (1 file, ~1 line added):

1. In `packages/sdk-rust/src/lib.rs`, after the existing `pub use` block (currently lines 42–48), append:
   ```rust
   pub use webhook::{parse_webhook, ParsedWebhook, WebhookError, DEFAULT_TOLERANCE_SEC};
   ```
   The exact symbol list must match the actual public exports of `packages/sdk-rust/src/webhook.rs` (PR #236). If the constant is named differently (e.g. `WEBHOOK_DEFAULT_TOLERANCE_SEC`), use the actual name. If a public type is named `WebhookFailureReason` instead of `WebhookError`, use the actual name. **Verify by reading `packages/sdk-rust/src/webhook.rs` before writing the re-export line** — do not invent symbols.

2. Leave `pub mod webhook;` at line 40 intact so qualified access (`zettapay::webhook::parse_webhook`) keeps working — this PR is purely additive.

3. Do **not** touch `Cargo.toml`, `README.md`, or examples. Docs follow-up is a separate mission.

Validation:
- `grep 'pub use webhook' packages/sdk-rust/src/lib.rs` returns exactly 1 match.
- `cd packages/sdk-rust && cargo check --all-targets` exits 0.
- `cd packages/sdk-rust && cargo build --release` exits 0.
- If `cargo test` is wired, run it and confirm green (no test changes expected).
- `npm run build` unaffected (Rust SDK has its own toolchain).
- Wallet-less hard rule N/A — no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-rust-webhook-reexport`. Open PR titled `feat(sdk-rust): re-export webhook helpers at crate root`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. vercel.json — add CORS headers to /api/(.*) so browser SDKs can call cross-origin
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'vercel: add CORS headers to /api/(.*) for browser SDK consumers',
$$Add `Access-Control-Allow-Origin`, `-Methods`, `-Headers`, and `Max-Age` headers to the existing `/api/(.*)` headers block in `vercel.json` so cross-origin SDK consumers (the embed widget on merchant sites, the public checkout page, third-party storefronts) can complete CORS preflight without a custom handler. Today the block ships only `Cache-Control: no-store` and `X-Powered-By: ZettaPay`, so every cross-origin POST from a merchant page fails at the OPTIONS preflight.

Scope (1 file, ~6 lines added):

1. In `vercel.json`, locate the existing `headers` array (currently at the bottom of the file, around lines 147–161). Inside the single block whose `source` is `/api/(.*)`, append these 4 header objects to the `headers` array (after the existing `Cache-Control` + `X-Powered-By` entries):

   ```json
   { "key": "Access-Control-Allow-Origin", "value": "*" },
   { "key": "Access-Control-Allow-Methods", "value": "GET, POST, PUT, PATCH, DELETE, OPTIONS" },
   { "key": "Access-Control-Allow-Headers", "value": "Authorization, Content-Type, Idempotency-Key, X-ZettaPay-Signature, X-ZettaPay-Timestamp, X-ZettaPay-Event-Id" },
   { "key": "Access-Control-Max-Age", "value": "86400" }
   ```

   The full `headers[0].headers` array should end up with 6 entries (the existing 2 plus these 4). Preserve trailing-comma JSON validity — `vercel.json` is strict JSON, not JSON-with-comments.

2. **Origin policy.** `*` is the right default for a public payments protocol with API-key auth: every endpoint authenticates via `Authorization: Bearer zp_live_...`, so a permissive origin policy does not weaken security. If a future mission tightens this to an explicit allowlist (merchant-domains-table-driven), that's a separate mission.

3. Do **not** touch any individual `api/*.ts` handler — Vercel applies the headers block at the edge before the handler runs, so per-handler `res.setHeader('Access-Control-Allow-Origin', ...)` is redundant. Keep the diff to `vercel.json` only.

4. **OPTIONS preflight.** Vercel returns 204 automatically for OPTIONS requests against routes with `Access-Control-Allow-Methods` set, so no per-handler OPTIONS branch is needed.

Validation:
- `node -e "JSON.parse(require('fs').readFileSync('vercel.json','utf8'))"` exits 0 (valid JSON).
- `grep -c 'Access-Control-Allow' vercel.json` returns exactly 3 (Origin, Methods, Headers).
- `grep -c 'Access-Control-Max-Age' vercel.json` returns exactly 1.
- After deploy, `curl -i -X OPTIONS https://<preview>.vercel.app/api/health -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: POST'` returns 204 with the four headers present.
- `npm run build` unaffected (vercel.json is config-only).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-vercel-cors-api`. Open PR titled `feat(vercel): add CORS headers to /api/(.*) for browser SDK consumers`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. api/pay.ts — emit X-RateLimit-* response headers (mirror api/faucet.ts pattern)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'api/pay: emit X-RateLimit-* response headers (mirror faucet pattern)',
$$Add `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` response headers to every code path in `api/pay.ts`. `api/faucet.ts` is the only endpoint in the entire `/api/*` lane that emits these today; `/api/pay` is the highest-value POST in the surface and is currently silent. Premissa 11 (rate-limit per API key with response headers) is the explicit driver — SDK consumers should be able to back off proactively instead of getting surprised by a 429.

Scope (1 file, ~10 lines added):

1. Read `api/faucet.ts` first to learn the exact header naming convention, value source, and where in the handler the headers are set. **Mirror that pattern exactly** — do not invent a new shape.

2. In `api/pay.ts`, add the three headers to every response path:
   - GET / HEAD branch (line 19): set headers before `res.status(200).json(...)`.
   - 405 branch (line 41): set headers before `res.status(405).json(...)`.
   - 400 `badRequest` helper (line 13): refactor to accept the headers and set them — OR set them at the top of the POST handler before any `badRequest` call so they're always present.
   - 201 success branch (line 100): set headers before `res.status(201).json(...)`.

3. **Header values.** If `api/faucet.ts` reads a real backing store (Redis, in-memory map), use the same backing store. If it returns static placeholder values (e.g. `Limit: 60`, `Remaining: 59`, `Reset: now+60s`), use the same static shape — this mission's goal is **emit the headers**, not implement a new rate-limiter. The real per-API-key limiter is a separate mission (and likely needs Redis state in the chronic-broken `packages/api/` lane).

4. **Idempotency-Key handling unchanged.** Existing validation at line 92 stays exactly as-is. Storing keys for replay protection is explicitly out of scope (see rationale doc rejected-candidate #4).

5. **Do not** add the headers to `api/payments.ts`, `api/merchants/register.ts`, `api/mcp.ts`, or any other endpoint in this PR. One-file scope keeps the PR auto-mergeable; the pattern can fan out in follow-up missions once this one validates.

Validation:
- `grep -c 'X-RateLimit' api/pay.ts` returns >= 3 (one per header name).
- `npm run build` unaffected (root `/api/` is the safe additive Vercel lane per worker memory `project_build_broken.md`).
- After deploy, `curl -i https://<preview>.vercel.app/api/pay` returns 200 (GET branch) with the three `X-RateLimit-*` headers present.
- `curl -i -X POST https://<preview>.vercel.app/api/pay -H 'content-type: application/json' -d '{"merchantId":"m_1","amount":1}'` returns 201 with the three headers present.
- Wallet-less hard rule N/A — no wallet code touched.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-api-pay-ratelimit-headers`. Open PR titled `feat(api): emit X-RateLimit-* headers on /api/pay (mirror faucet)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. api/index.ts — sync endpoint discovery JSON with current vercel.json rewrites
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'api/index: sync endpoint discovery JSON with vercel.json rewrites',
$$Expand the `endpoints` object returned by `GET /api` (`api/index.ts`, lines 9–24) so it actually reflects every public route declared in `vercel.json` rewrites. Today the JSON lists 14 endpoints; the real public surface is roughly 33 (`vercel.json` has 32 rewrite entries plus the root `/`). A developer hitting `/api` as a discovery probe currently sees **no** `/status`, no `/status/feed.rss`, no `/signup`, no `/launch`, no `/pricing`, no `/docs`, no `/checkout`, no `/dashboard`, no per-merchant `/merchants/[merchant]/settings` or `/merchants/[merchant]/keys`. Premissa 24 (docs site is a trust signal) — `GET /api` is the API equivalent of a docs landing page and must be accurate.

Scope (1 file, ~25 lines reshaped):

1. In `api/index.ts`, replace the flat `endpoints` object with a categorised structure:
   ```ts
   endpoints: {
     api: {
       health: '/api/health',
       healthz: '/api/healthz',
       ready: '/api/ready',
       metrics: '/api/metrics',
       status: '/api/status',
       statusFeed: '/api/status/feed.rss',
       faucet: '/api/faucet',
       pay: '/api/pay',
       payments: '/api/payments',
       simulate: '/api/simulate/:merchant',
       analytics: '/api/analytics/:merchant',
       merchantsRegister: '/api/merchants/register',
       merchantsOnboard: '/api/merchants/onboard',
       mcp: '/api/mcp',
       onramp: '/api/onramp',
       onrampWebhook: '/api/onramp/webhook',
     },
     site: {
       home: '/',
       pricing: '/pricing',
       signup: '/signup',
       launch: '/launch',
       docs: '/docs',
       docsQuickstart: '/docs/quickstart',
       docsEmbed: '/docs/embed',
       docsFaucet: '/docs/faucet',
       docsApi: '/docs/api',
       status: '/status',
       about: '/about',
       contact: '/contact',
       privacy: '/privacy',
       terms: '/terms',
       pay: '/pay',
       checkout: '/checkout/:invoice_id',
       dashboard: '/dashboard',
       dashboardMerchant: '/dashboard/:merchant',
       dashboardPayouts: '/dashboard/:merchant/payouts',
     },
   },
   ```

   **Verify each path against `vercel.json` rewrites before pasting** — if any path above does not have a matching rewrite, drop it. If `vercel.json` has a rewrite this list omits, add it. The list above is generated from the current `vercel.json` snapshot but must be cross-checked at mission-execution time.

2. **Schema-breaking change check.** Any downstream caller (the docs site, the embed widget, a test harness) that consumes the flat shape will now see a nested shape. Search the repo for callers: `grep -rn "endpoints\.pay\|endpoints\.health\|endpoints\.faucet" --include="*.ts" --include="*.html" --include="*.js"`. If any caller exists, **either** add a temporary `endpointsFlat` mirror at the top level for one release **or** abort the PR and flag the breaking-change risk in the PR body. (Quick check at audit time: no callers found in `public/` or `api/`, so the nested shape is safe — but re-verify at execution time.)

3. Bump `version` from `'0.1.0'` to `'0.2.0'` to signal the shape change.

4. Keep the existing `withSentry(handler)` wrapping intact.

Validation:
- `node -e "const f=require('fs');const c=f.readFileSync('vercel.json','utf8');const r=JSON.parse(c).rewrites;const api=r.filter(x=>x.destination.startsWith('/api/')).length;const site=r.filter(x=>x.destination.endsWith('.html')).length;console.log({api,site});"` — every `api/*` rewrite must be reflected under `endpoints.api`; every `site/*` rewrite under `endpoints.site`.
- `tsc --noEmit api/index.ts` exits 0.
- `npm run build` unaffected (root `/api/` safe lane).
- After deploy, `curl -s https://<preview>.vercel.app/api | jq '.endpoints | keys'` returns `["api", "site"]`.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-api-index-endpoints-sync`. Open PR titled `feat(api): sync /api endpoint discovery with vercel.json rewrites`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit journal entry
INSERT INTO fabric_audit_journal (event_type, payload)
VALUES
  ('auto_regen_executed',
   jsonb_build_object(
     'workspace_id', 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
     'source_mission_uuid_prefix', '4f79ec06',
     'branch', 'auto/4f79ec06--auto-discovery-identificar-pr-ximos-5-g',
     'generated_at', '2026-05-16',
     'upstream_signal', 'fresh repo scan of SDK package roots + root /api lane + vercel.json (no upstream audit doc)',
     'missions_created', jsonb_build_array(
       'sdk-python: re-export parse_webhook + WebhookError at package root',
       'sdk-rust: re-export webhook public symbols at crate root',
       'vercel: add CORS headers to /api/(.*) for browser SDK consumers',
       'api/pay: emit X-RateLimit-* response headers (mirror faucet pattern)',
       'api/index: sync endpoint discovery JSON with vercel.json rewrites'
     ),
     'rejected_candidates', jsonb_build_object(
       'env_example_solana_usdc_mint_rename', 'Out-of-scope: bug fix requires editing packages/api/src/config.ts (chronic-broken compile lane) or accepting a documented-vs-code mismatch. Routing decision — human triage.',
       'env_example_document_missing_vars', 'Out-of-scope: most undocumented vars are read by packages/api source. Need a clean audit pass after the chronic build break is repaired. PR #233 (open) already covers LOG_PRETTY.',
       'cors_on_onramp_webhook', 'Out-of-scope: inbound webhook receivers validate signatures, not whitelist origins. Wrong fix.',
       'idempotency_key_full_impl', 'Out-of-scope: requires Postgres-backed dedupe store in packages/api (chronic-broken lane). Multi-file, not single-shot.',
       'packages_api_chronic_build_repair', 'Out-of-scope: multi-file fix in chronic-broken lane. Worker memory project_build_broken.md.',
       'z29_4_zombie_sentinel_chain', 'Out-of-scope: orchestrator-side UUID stickiness, not a code mission.'
     ),
     'notes', 'Fresh scan after prior two backlog refills (fba46358 → SDK webhook helpers + bug-bounty doc; 69cdcbce → Z33E site-launch fixes). All 5 picks target SDK public API + safe /api lane + vercel.json. None touch packages/api. None touch wallet code. Supabase MCP unavailable to worker per memory feedback_supabase_mcp_unavailable.md — orchestrator applies this SQL post-merge or human operator runs it with service-role key.'
   ));

COMMIT;
