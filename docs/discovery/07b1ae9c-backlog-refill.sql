-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 07b1ae9c
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/07b1ae9c-backlog-refill.md
-- All 5 picks are single-file, single-objective, additive, and outside the
-- chronic-broken packages/api compile lane. None touch wallet code.
--
-- Themes covered: vercel safe security headers, next-pass test coverage
-- (embed/rpc + widget/api), per-SDK LICENSE parity (sdk-rust), and a
-- GitHub-rendered SUPPORT.md routing file. Picks were drawn from surfaces
-- explicitly NOT in any of the 12 most-recent refills (#231 through #260)
-- nor the in-flight pending queue.
--
-- Repeat-rejection themes deliberately AVOIDED in this refill (each rejected
-- 2+ times by prior reviewers): CHANGELOG.md (release-ops decision),
-- CODEOWNERS (owner/team decision), FUNDING.yml (sponsor target bikeshed),
-- CODE_OF_CONDUCT.md (enforcement contact decision), aggressive CSP /
-- HSTS / X-Frame-Options (could break inline scripts + iframe embeds).
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. vercel.json — safe public-asset security headers (no CSP/X-Frame/HSTS)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(vercel): safe security headers — nosniff + referrer + perms',
$$Add three industry-standard public-asset security headers to `vercel.json`'s top-level `"headers"` block. Today only `/api/(.*)` is covered (Cache-Control + X-Powered-By); the entire static `public/` surface — `index.html`, `pay.html`, `dashboard.html`, `checkout.html`, `signup.html`, `pricing.html`, `launch.html`, `status.html`, `about.html`, `contact.html`, `privacy.html`, `terms.html`, the `docs/` folder, the `dashboard/` folder, `embed.js`, the OG/logo PNGs — ships with **zero** security headers.

Premissa 22 says "CSP headers configured in middleware". For ZettaPay (no Next.js middleware), the equivalent is the `vercel.json` headers config. Prior refill `03cf9a17` explicitly REJECTED the bundle of {CSP, X-Frame-Options, HSTS} because aggressive CSP can break inline scripts on `pay.html` / `dashboard.html` and X-Frame-Options: SAMEORIGIN would block the embed widget. This mission ships ONLY the safe subset that none of those concerns touch.

Scope (1 file, ~20-25 LOC addition — no removals, no reordering):

1. Open `vercel.json`. Locate the `"headers"` array (currently one entry for `/api/(.*)`).
2. Append a SECOND entry that matches all top-level paths and adds:
   - `X-Content-Type-Options: nosniff` — MIME-sniff protection, no behavioral change for any served asset; always safe.
   - `Referrer-Policy: strict-origin-when-cross-origin` — current browser default for new sites; prevents leaking checkout/dashboard URL paths to cross-origin destinations.
   - `Permissions-Policy: interest-cohort=(), browsing-topics=()` — opts out of Chrome's tracking-cohort APIs; no behavioral change for payment flows.
3. The new entry's `"source"` should match the broadest pattern that does NOT collide with the existing `/api/(.*)` entry's specificity rules. Vercel evaluates `headers` array order: later entries override earlier ones only when the path overlaps AND the key is the same. Use `"source": "/(.*)"` and rely on Vercel's merge semantics (the two entries cover disjoint header keys: Cache-Control/X-Powered-By stays on /api/*, the three new headers apply globally including /api/*).
4. Do NOT add `Strict-Transport-Security` (HSTS) — Vercel terminates TLS already; HSTS via Vercel headers is generally a no-op and prior refill flagged it as "needs page-by-page audit".
5. Do NOT add `Content-Security-Policy` — it requires a per-page audit of inline scripts / `script-src` allowlists for Recharts, the QR generator, MoonPay onramp, and the demo simulator.
6. Do NOT add `X-Frame-Options` — `checkout.html` is intentionally embeddable via `@zettapay/embed`, and SAMEORIGIN would break that.

Validation:
- `jq -e '.headers | length == 2' vercel.json` returns true.
- `jq -e '.headers[1].headers | map(.key) | contains(["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"])' vercel.json` returns true.
- `npm run build` is unaffected (vercel.json is config, not compiled).
- Wallet-less hard rule N/A — no source files touched.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Premissa references: 22 (security headers) directly; 19 (bug-bounty trust signal) indirectly.

Branch: `auto/<uuid>-vercel-safe-security-headers`. Open PR titled `chore(vercel): safe public-asset security headers — nosniff + Referrer-Policy + Permissions-Policy`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. embed — cover rpc.ts with vitest (next-pass after queued poll.test.ts)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(embed): cover rpc.ts (wrapped fetch + RPC helpers)',
$$Add a new test file `packages/embed/test/rpc.test.ts` covering the wrapped-fetch helpers in `packages/embed/src/rpc.ts` (103 LOC). Today `packages/embed/test/` holds only `embed.test.ts` + `wallets.test.ts`. Prior refill `2e05f052` queued `poll.test.ts`; the same refill's rejected-candidates section explicitly flagged `rpc.ts` as the "good single-file pick for next pass once poll.test.ts proves the mock seam" — this is that next-pass mission.

Premissa 29 (coverage > 70% on critical paths). `rpc.ts` is on the critical path: every payment-detection cycle inside the embed calls `getSignaturesForAddress` + `getParsedTransaction`. Any regression in the JSON-RPC envelope construction or error-mapping silently breaks payment detection in the wild.

Scope (1 new file, ~110-150 LOC):

1. Create `packages/embed/test/rpc.test.ts`.
2. Stub `fetch` with `vi.spyOn(globalThis, 'fetch')` (matching the pattern in `embed.test.ts`). Do NOT add `msw`, `nock`, or any new dep — embed.js is "zero runtime dependencies" per its own README.
3. Cover at minimum:
   - **RPC_URL constant** — assert `'mainnet-beta'` and `'devnet'` map to the canonical public endpoints.
   - **USDC_MINT constant** — assert both clusters match the canonical mint addresses (catch a copy-paste typo that would break payment detection on every transaction).
   - **getSignaturesForAddress happy path** — fetch resolves with `{result: [...]}` → return signature list.
   - **getSignaturesForAddress passes limit param** — assert the request body includes `[address, {limit: 25}]` when called with `limit=25`.
   - **getSignaturesForAddress request shape** — POST + JSON content-type header + JSON-RPC envelope (`jsonrpc: '2.0'`, monotonic `id`, method `'getSignaturesForAddress'`).
   - **rpc() http error** — fetch resolves with `{ok: false, status: 503}` → throws `rpc http 503`.
   - **rpc() body error** — fetch resolves with `{result: undefined, error: {message: 'invalid'}}` → throws `rpc error: invalid`.
   - **getParsedTransaction options** — assert the params include `{encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0}`.
   - **getParsedTransaction null result** — `{result: null}` → resolves to null (signature not found is not an error).
   - **Monotonic id** — two sequential calls produce two distinct ascending `id` values in the request body.
4. Use `describe` blocks per function, `it` per case. Reset spies between tests via `beforeEach(() => vi.clearAllMocks())`.
5. Do NOT refactor `rpc.ts` itself — tests only.

Validation:
- `cd packages/embed && npm run test` exits 0 with the new file's tests passing.
- `npm run build` unaffected (test files are not bundled into `dist/embed.js`).
- Wallet-less hard rule N/A — no wallet code in rpc.ts; tests are pure unit tests.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-rpc-tests`. Open PR titled `test(embed): cover rpc.ts with vitest`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. widget — cover api.ts with vitest (next-pass after queued qr.test.ts)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(widget): cover api.ts (createPaymentIntent + pollPaymentStatus)',
$$Add a new test file `packages/widget/test/api.test.ts` covering the HTTP-helper surface in `packages/widget/src/api.ts` (167 LOC). Today `packages/widget/test/` holds only `widget.test.ts`. Prior refill `2e05f052` queued `qr.test.ts` and its rejected-candidates section listed `api.test.ts` as the next-pass candidate ("`api.ts` needs fetch mocking infra... becomes its own mission once qr.test.ts lands"). This is that next-pass mission.

Premissa 29 (coverage > 70% on critical paths). `api.ts` is the widget's only network surface — every modal open hits `createPaymentIntent`, every payment confirmation goes through `pollPaymentStatus`. A regression in idempotency-key generation, the merchant/amount payload shape, or the 404-retry semantics silently breaks every embedded checkout.

Scope (1 new file, ~150-200 LOC):

1. Create `packages/widget/test/api.test.ts`.
2. Stub `fetch` with `vi.spyOn(globalThis, 'fetch')` and use vitest's `vi.useFakeTimers()` for the polling tests to avoid real 2.5s waits. Do NOT add `msw`, `nock`, or any new dep — widget package's `devDependencies` are minimal by design.
3. Cover at minimum:

   **createPaymentIntent:**
   - **Happy path** — POST to `${apiBase}/pay`, response `{payment: {id, merchantId, amount, currency, status, txSignature, createdAt}}` → returns normalized PaymentIntent.
   - **Idempotency-Key header** — every call includes `idempotency-key` matching `/^[a-z0-9-]+$/i` (UUID v4 or `wgt-...` fallback shape).
   - **x-zettapay-widget header** — present, defaults to `'dev'` when global version sentinel absent.
   - **Body shape** — `{merchantId, amount, currency, metadata: {..., source: 'widget'}}`. Note the always-injected `source: 'widget'` in metadata.
   - **Base trimming** — trailing slashes on `apiBase` are stripped (assert `https://api.x.io/` and `https://api.x.io///` both produce `https://api.x.io/pay`).
   - **HTTP error with JSON body** — 400 + `{error: {code: 'invalid_merchant', message: 'no such merchant'}}` → throws `ApiError` with `.code === 'invalid_merchant'`, `.status === 400`.
   - **HTTP error with non-JSON body** — 502 + plain text → throws `ApiError` with `.code === 'http_502'`.
   - **Missing id in response** — `{}` or `{payment: {}}` → throws `ApiError('invalid_response', ...)`.

   **pollPaymentStatus:**
   - **Terminal status returned** — second poll returns `{payment: {..., status: 'completed'}}` → resolves with `{status: 'completed', intent}`.
   - **404 → retry** — first response 404, second response `{payment: {..., status: 'completed'}}` → resolves (404 must NOT throw).
   - **5xx → throws** — any 5xx → `ApiError('http_5xx', ...)`.
   - **AbortSignal honored** — aborting the signal mid-poll → throws `ApiError('aborted', ...)` (use `vi.advanceTimersByTime` to step through the 2.5 s tick).
   - **Timeout** — 5 minutes of `pending` responses with fake timers → resolves with `{status: 'timeout', intent: {id, merchantId: '', amount: 0, ...}}`.

   **normalizeIntent (indirect coverage):**
   - Accepts both `{payment: {...}}` and flat `{id, ...}` shapes.
   - Coerces `amount` from string to number; falls back to `amountUsdc`.
   - Defaults missing `currency` to `'USDC'`, missing `status` to `'pending'`, missing `txSignature` to `null`.

4. Use `describe` blocks per function, `it` per case. Reset spies and timers between tests via `beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); })` and `afterEach(() => vi.useRealTimers())`.
5. Do NOT refactor `api.ts` itself — tests only. If `cryptoRandomId` is hard to test deterministically, stub `globalThis.crypto.randomUUID` in the relevant `it` blocks; do not change the production code.

Validation:
- `cd packages/widget && npm run test` exits 0 with the new file's tests passing.
- `npm run build` unaffected (test files are not in `tsconfig.types.json` include[]).
- Wallet-less hard rule N/A — `api.ts` is pure HTTP (no wallet code).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-api-tests`. Open PR titled `test(widget): cover api.ts with vitest`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. sdk-rust — ship MIT LICENSE file at crate root (crates.io recommends)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(sdk-rust): ship LICENSE at crate root (crates.io)',
$$Add `packages/sdk-rust/LICENSE` containing the MIT license text matching the root `LICENSE` of this repository. Today the Rust SDK only declares `license = "MIT"` in `Cargo.toml`; the crate root has no LICENSE file. Prior refill `e365137f` flagged per-SDK LICENSE parity (sdk-rust + sdk-python + sdk-go + sdk-php all lack files) but rejected the BUNDLE as four separate missions. This mission ships ONE — sdk-rust — because:

- crates.io's publish guidelines specifically recommend shipping `LICENSE` or `LICENSE-MIT` / `LICENSE-APACHE` files at crate root so the crates.io page can display them inline; `license = "MIT"` in `Cargo.toml` alone produces a "License file not bundled" warning on `cargo publish`.
- The Rust SDK has the most mature publishing pipeline (already wired for crates.io per `packages/sdk-rust/Cargo.toml` metadata: `repository`, `homepage`, `documentation`, `categories`, `keywords` all set).
- The other three SDKs (Python via PyPI, Go via go.mod, PHP via Packagist) tolerate license-metadata-only configurations more gracefully and should each be separate missions ordered by publication priority.

Premissa 31 ("Open source: protocol spec + SDKs MIT") + Premissa 23 (SDK-first DX).

Scope (1 new file, ~21 LOC — verbatim MIT text):

1. Create `packages/sdk-rust/LICENSE` containing the exact same MIT text as the repository root `LICENSE`. Copy verbatim — do not modify the copyright holder line (`Copyright (c) 2026 ZettaPay contributors`).
2. Do NOT modify `packages/sdk-rust/Cargo.toml`. The `license = "MIT"` field is already correct; no `license-file` field is needed because `LICENSE` at crate root is the conventional fallback.
3. Do NOT add `LICENSE-MIT` / `LICENSE-APACHE` dual-license files — the project is MIT-only; dual-licensing is a separate strategic decision (the root LICENSE is MIT-only).
4. Do NOT touch `packages/sdk-python/`, `packages/sdk-go/`, or `packages/sdk-php/` — those are separate missions per the prior reviewer's rejection rationale.

Validation:
- `diff packages/sdk-rust/LICENSE LICENSE` returns no diff (file is verbatim copy).
- `cargo publish --dry-run --manifest-path packages/sdk-rust/Cargo.toml` (if Rust toolchain available) no longer emits the "license file not bundled" warning. CI does not run Rust; this validation is human-verifiable post-merge by a maintainer with `cargo` installed.
- `npm run build` unaffected — the file lives outside any TypeScript include path.
- Wallet-less hard rule N/A — LICENSE file is plain text, no code.
- Brand discipline: no Claude/Anthropic mentions in the file or commit. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-rust-license`. Open PR titled `chore(sdk-rust): ship LICENSE at crate root (MIT)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. .github/SUPPORT.md — GitHub-rendered routing file (no new channels)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore(.github): SUPPORT.md routing to existing surfaces',
$$Create `.github/SUPPORT.md` — a GitHub-rendered support-routing file that points users to surfaces that ALREADY exist in this repo. GitHub displays this file as a "Get help" panel in the "New issue" flow and links it from the repo's community profile. Today the repo has no SUPPORT.md, so new users opening issues have no routing context — security reports, billing questions, and feature requests all land in the same /issues queue.

This mission is deliberately scoped to be **strictly a re-router** — it adds zero new email addresses, zero new chat channels, zero new support tiers. It ONLY links to surfaces that already exist in the repo, so the rejection rationale from prior refills (CHANGELOG / CODEOWNERS / FUNDING / CODE_OF_CONDUCT all rejected because "needs ops decision") does NOT apply.

Premissa 25 (DevRel + open SDK > paid marketing — community surfaces matter) + Premissa 31 (open source trust signal).

Scope (1 new file, ~30-45 LOC of pure markdown):

1. Create `.github/SUPPORT.md`. Use the following structure (the exact prose can be tuned; the routing targets are FIXED):

   ```markdown
   # ZettaPay Support

   Routing for questions, bugs, and security reports. Pick the channel that
   matches your need.

   ## Documentation
   - Quickstart and integration guides: [`docs/`](../docs/)
   - Protocol spec: [`protocol/`](../protocol/)
   - API reference: [`docs/api-reference/`](../docs/api-reference/)

   ## Code samples
   - Ten end-to-end examples (Solana Pay, x402, MCP, Shopify, Discord,
     Next.js, webhook listener, subscriptions, more): [`examples/`](../examples/)

   ## SDKs
   - TypeScript: [`packages/sdk/`](../packages/sdk/)
   - Python: [`packages/sdk-python/`](../packages/sdk-python/)
   - Rust: [`packages/sdk-rust/`](../packages/sdk-rust/)
   - Go: [`packages/sdk-go/`](../packages/sdk-go/)
   - PHP: [`packages/sdk-php/`](../packages/sdk-php/)

   ## Bug reports + feature requests
   Open a [GitHub issue](https://github.com/leandromaiam-code/zettapay/issues).

   ## Security reports
   Do NOT open a public GitHub issue for security findings. See the
   in-repo bug bounty docs: [`audit/BUG_BOUNTY.md`](../audit/BUG_BOUNTY.md).
   Coordinated disclosure is rewarded; see the bounty doc for scope,
   submission format, and payout tiers.

   ## Status
   - Public status page: [`/status`](https://zettapay.vercel.app/status)
   - Incident feed: [`/status/feed.rss`](https://zettapay.vercel.app/status/feed.rss)

   ## Community
   - Discord configuration + bot: [`community/discord/`](../community/discord/)
   - Twitter (links): [`community/twitter/`](../community/twitter/)
   - Third-party listings: [`community/listings/`](../community/listings/)
   ```

2. Do NOT add a `support@zettapay.io` email — that needs an ops decision per the prior refill rejection of `support.email` (`e365137f`).
3. Do NOT add Slack / Telegram / pager links — same rationale.
4. Do NOT add SLA promises ("we respond within 24h") — pre-mainnet, no SLA has been published.
5. Do NOT modify the repo `README.md`. GitHub automatically surfaces `.github/SUPPORT.md` without README edits.
6. ALL links must resolve to existing paths in this repo or to the existing public URLs (`zettapay.vercel.app/status` is the live status page, already routed via `vercel.json`).

Validation:
- Every relative link in the file resolves: `for path in docs/ protocol/ docs/api-reference/ examples/ packages/sdk/ packages/sdk-python/ packages/sdk-rust/ packages/sdk-go/ packages/sdk-php/ audit/BUG_BOUNTY.md community/discord/ community/twitter/ community/listings/; do test -e "$path" || echo "MISSING: $path"; done` prints nothing.
- `npm run build` unaffected (file is markdown, not compiled).
- Wallet-less hard rule N/A — pure markdown, no code.
- Brand discipline: no Claude/Anthropic mentions. No "revolução"/"disrupção"/"sinergia"/"game-changer" verbiage. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-github-support`. Open PR titled `chore(.github): SUPPORT.md routing to in-repo support surfaces`.$$,
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
     'mission_uuid_prefix', '07b1ae9c',
     'generated_at', '2026-05-17',
     'companion_doc', 'docs/discovery/07b1ae9c-backlog-refill.md',
     'mission_names', jsonb_build_array(
       'chore(vercel): safe security headers — nosniff + referrer + perms',
       'test(embed): cover rpc.ts (wrapped fetch + RPC helpers)',
       'test(widget): cover api.ts (createPaymentIntent + pollPaymentStatus)',
       'chore(sdk-rust): ship LICENSE at crate root (crates.io)',
       'chore(.github): SUPPORT.md routing to existing surfaces'
     ),
     'themes', jsonb_build_array(
       'vercel-safe-security-headers',
       'embed-test-coverage-next-pass',
       'widget-test-coverage-next-pass',
       'per-SDK-LICENSE-parity (sdk-rust only)',
       'github-support-routing'
     ),
     'avoided_repeat_rejections', jsonb_build_array(
       'CHANGELOG.md (release-ops decision)',
       'CODEOWNERS (owner/team decision)',
       'FUNDING.yml (sponsor target bikeshed)',
       'CODE_OF_CONDUCT.md (enforcement contact decision)',
       'aggressive CSP / HSTS / X-Frame-Options (page-by-page audit needed)',
       'support.email / support.chat (ops decision)'
     ),
     'prior_refill_chain', jsonb_build_array(
       '#260 (03cf9a17)', '#259 (e365137f)', '#258 (66b549af)', '#257 (d5806497)',
       '#254 (bf6837e4)', '#253 (9db4cb78)', '#252 (a82d92db)', '#251 (1986ee3d)',
       '#245 (2e05f052)', '#244 (4f79ec06)', '#242 (69cdcbce)', '#231 (fba46358)'
     )
   ));
