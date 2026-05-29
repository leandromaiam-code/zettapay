-- Auto-discovery backlog refill — generated 2026-05-29
-- Source mission UUID prefix: 291b8665
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/291b8665-backlog-refill.md
--
-- Themes covered (5 picks, all single-file scope, additive, none touching the
-- chronic-broken packages/api compile lane, none touching wallet-connect
-- code):
--
--   1. SECURITY: lock /api/internal/webhooks/test/[invoiceId].ts behind a
--      ZETTAPAY_INTERNAL_TOKEN bearer header. Today the endpoint accepts an
--      arbitrary `webhook_url_override` + `webhook_secret_override` from any
--      unauthenticated POST — a textbook open-relay + HMAC-oracle, on the
--      public /api/* surface. This is THE highest-blast-radius gap in the
--      Vercel functions tree right now (audit/OWASP_TOP_10.md A05 + A10).
--
--   2. SECURITY: lock /api/internal/listener/status.ts behind the same
--      ZETTAPAY_INTERNAL_TOKEN bearer header. Today it returns
--      `subscribed_addresses` (live invoice count) + `last_invoice_at` to any
--      anonymous caller — pre-launch competitive intelligence leak and an
--      enumeration vector for active addresses. Same env name as pick 1 so
--      a single secret rotation covers both.
--
--   3. TEST: api/test/acceptance/xpub-rejects-private.ts — public acceptance
--      probe that exercises parseMerchantXpub() against every private-key
--      variant the HARD-RULE wallet-less architecture refuses (xprv, zprv,
--      yprv, tprv, uprv, vprv) AND against a canonical valid zpub + tpub.
--      Returns {ok, checks: {…}} like the existing btc-payment +
--      self-hosted-listener probes. HR-CUSTODY is the most important
--      invariant in the codebase; it currently only has an integration
--      test indirectly via /api/test/acceptance/btc-payment.ts.
--
--   4. TEST: api/test/acceptance/confirmation-tiers.ts — public acceptance
--      probe that exercises requiredConfirmations() at every tier boundary
--      ($0, $1, $49.99, $50.00, $499.99, $500.00, $1_000_000, NaN, -1,
--      Infinity). The function is consumed by every BTC invoice creation
--      and a wrong tier directly maps to financial loss (under-confirmed
--      releases) or merchant friction (over-confirmed waits). Today there
--      is NO test for this function anywhere in the tree.
--
--   5. TEST: packages/sdk/test/server/events.test.ts — unit coverage for
--      parseEvent() in packages/sdk/src/server/events.ts. Z66 shipped the
--      function + Zod schema but only webhook.test.ts exists in
--      packages/sdk/test/server/. parseEvent is the canonical narrowing
--      seam merchants use to type their webhook handlers — its discriminated
--      union must survive every refactor.
--
-- Repeat-rejection themes deliberately AVOIDED in this refill (rejected 2+
-- times by prior reviewers): CHANGELOG.md, CODEOWNERS, FUNDING.yml,
-- CODE_OF_CONDUCT.md, PWA manifest, favicons, aggressive CSP / HSTS /
-- X-Frame-Options. Also avoided: any new docs/* missions (last 6 auto-regens
-- — PRs #258-264 — were all docs refills; reviewer fatigue is real).
--
-- The mission worker could not reach Supabase MCP directly
-- (feedback_supabase_mcp_unavailable.md). These statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- applies on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. SECURITY: bearer-token gate on /api/internal/webhooks/test/[invoiceId]
-- ---------------------------------------------------------------------------
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sec(api): bearer-token gate on internal/webhooks/test',
$$Gate `api/internal/webhooks/test/[invoiceId].ts` behind a bearer-token check using the new env var `ZETTAPAY_INTERNAL_TOKEN`. Today the endpoint accepts arbitrary `webhook_url_override` + `webhook_secret_override` from any unauthenticated POST, so a public attacker can:

  • Use ZettaPay as a free HMAC-signing oracle (sign any body with any secret).
  • POST attacker-controlled JSON bodies to arbitrary HTTP URLs through Vercel egress (open relay / blind SSRF probing internal targets).
  • Persist forged rows into `zettapay_webhook_events` against any merchant_id when a real invoice id is guessed (`inv_<32 hex>` — 128 bits, expensive but not infeasible long-term).

This is OWASP A05 (Security Misconfiguration) + A10 (SSRF) — audit/OWASP_TOP_10.md flags both. The `/internal/` path prefix is convention-only — Vercel routes the file as a normal public function. See `vercel.json` lines 156-168.

Scope (1 file modified — DO NOT extract a shared helper in this PR; pick 2 ships its own copy so the two endpoints can be reviewed + reverted independently):

1. At the top of `api/internal/webhooks/test/[invoiceId].ts`, immediately after the method check (line 73, after the 405), read `process.env.ZETTAPAY_INTERNAL_TOKEN`:
   - If unset → respond `503 { error: { code: 'internal_token_not_configured', message: 'Set ZETTAPAY_INTERNAL_TOKEN to enable this endpoint' } }`. Refuse to fall back to "open in dev" — that's the bug that ships to prod.
   - If set → require header `Authorization: Bearer <token>`. Compare using `node:crypto` `timingSafeEqual` on equal-length Buffers (re-use the same constant-time pattern already in `api/_lib/hmac.ts` verifyWebhook).
   - On mismatch → respond `401 { error: { code: 'unauthorized', message: 'invalid or missing bearer token' } }`. NEVER echo the expected token or its length.
2. Do NOT touch the body-parsing, HMAC, or Supabase-persistence paths below the gate. Behavior after the gate is unchanged.
3. Update `.env.example` adding `ZETTAPAY_INTERNAL_TOKEN=REPLACE_ME` with a one-line comment. Use literal `REPLACE_ME` (NOT a long `whsec_...` placeholder — hr-scan rejects those, see `feedback_hr_secret_placeholders.md`).
4. Do NOT modify the other `/api/internal/*` endpoints — pick 2 handles `listener/status.ts` in its own PR.
5. Acceptance probe `api/test/acceptance/btc-payment.ts` calls this endpoint (check #6 `webhook_hmac`). It must continue to pass: have the probe read the same env var and send the bearer header. Add ~3 LOC to `btc-payment.ts` (this is the ONE additional file the mission may touch; total scope = 2 files modified + 1 env-example edit).

Validation:
- `grep -n "ZETTAPAY_INTERNAL_TOKEN" api/internal/webhooks/test/[invoiceId].ts` returns ≥2 hits (env read + comparison).
- `grep -n "timingSafeEqual" api/internal/webhooks/test/[invoiceId].ts` returns ≥1 hit.
- `curl -X POST https://<preview>/api/internal/webhooks/test/inv_…` without the header returns 401 or 503 (NOT 200, NOT 400).
- `curl -X POST -H "Authorization: Bearer $TOKEN" …` against a preview with the token set returns the same shape as before (signature + payload + verifier_check).
- `npm run build` passes (no new deps).
- Wallet-less hard rule N/A — this is a server-side fix.
- Brand discipline: no Claude/Anthropic in code, comments, commit. Co-author: Veridian Fabric.

Out of scope (call out in the PR description so future reviewers don't expect them):
- Rate-limiting (separate mission).
- Audit-log row on auth failure (separate mission).
- Shared `api/_lib/internal-auth.ts` helper (intentionally inlined — see scope step 1).

Branch: `auto/<uuid>-internal-webhook-test-auth`. Open PR titled `sec(api): require ZETTAPAY_INTERNAL_TOKEN on internal/webhooks/test`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- ---------------------------------------------------------------------------
-- 2. SECURITY: bearer-token gate on /api/internal/listener/status
-- ---------------------------------------------------------------------------
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sec(api): bearer-token gate on internal/listener/status',
$$Gate `api/internal/listener/status.ts` behind the same `ZETTAPAY_INTERNAL_TOKEN` bearer-token introduced by the companion mission `sec(api): bearer-token gate on internal/webhooks/test`. Today this endpoint is unauthenticated and leaks:

  • `subscribed_addresses` — count of live (non-expired, pending) invoices. Pre-launch competitive-intelligence signal AND a tampering signal for an attacker (they can poll to detect when ZettaPay starts watching new addresses).
  • `last_invoice_at` — exposes invoice cadence.
  • `connected` + `upstream` — mempool.space WS URL (low-sensitivity but unnecessary).

`/internal/` is convention-only on Vercel (vercel.json routes everything under `api/**/*.ts`). This is the second of two internal endpoints; the first lands the bearer-token discipline.

Order: this mission MAY land before or after pick 1. Both ship their own inlined check using the SAME env var name so a single secret rotation covers both. If pick 1 lands first, mirror its bearer-check verbatim; if this lands first, pick 1 mirrors verbatim. Reviewers should accept either order.

Scope (1 file modified — additive):

1. At the top of `api/internal/listener/status.ts`, immediately after the method check (line 25, after the 405), read `process.env.ZETTAPAY_INTERNAL_TOKEN`:
   - If unset → `503 { error: { code: 'internal_token_not_configured', message: 'Set ZETTAPAY_INTERNAL_TOKEN to enable this endpoint' } }`.
   - If set → require `Authorization: Bearer <token>`. Compare via `node:crypto` `timingSafeEqual` on equal-length Buffers.
   - Mismatch → `401 { error: { code: 'unauthorized', message: 'invalid or missing bearer token' } }`.
2. Leave the probeMempoolWs + Supabase paths below the gate untouched.
3. Acceptance probe `api/test/acceptance/btc-payment.ts` calls this endpoint (check #4 `listener`). Add ~3 LOC so it sends the bearer header when the env is set — if pick 1 already added the env read to this file, just reuse it; otherwise inline the same 3-LOC pattern. Net scope = 2 files modified.
4. Do NOT touch `.env.example` — pick 1 already adds the var. If pick 1 has not landed yet, add the `ZETTAPAY_INTERNAL_TOKEN=REPLACE_ME` line and the mission is 3 files. The orchestrator will deduplicate on merge.

Validation:
- `grep -n "ZETTAPAY_INTERNAL_TOKEN" api/internal/listener/status.ts` returns ≥2 hits.
- `grep -n "timingSafeEqual" api/internal/listener/status.ts` returns ≥1 hit.
- `curl https://<preview>/api/internal/listener/status` without bearer returns 401 or 503.
- With bearer, body still includes `connected`, `subscribed_addresses`, `last_invoice_at`.
- `npm run build` passes.
- Wallet-less hard rule N/A. Brand discipline: no Claude/Anthropic mentions.

Branch: `auto/<uuid>-internal-listener-status-auth`. Open PR titled `sec(api): require ZETTAPAY_INTERNAL_TOKEN on internal/listener/status`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- ---------------------------------------------------------------------------
-- 3. TEST: HR-CUSTODY xpub-rejects-private acceptance probe
-- ---------------------------------------------------------------------------
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(api): xpub HR-CUSTODY acceptance probe',
$$Ship `api/test/acceptance/xpub-rejects-private.ts` — a public Vercel function (no auth, GET-only) that exercises `parseMerchantXpub()` from `api/_lib/xpub.ts` against every private-key variant the HARD-RULE wallet-less architecture refuses, plus one valid mainnet zpub and one valid testnet tpub. Returns `{ok: <all_checks_passed>, checks: {…}}` mirroring the shape of the existing acceptance probes `api/test/acceptance/btc-payment.ts` and `api/test/acceptance/self-hosted-listener.ts`.

Why this is load-bearing:
- HR-CUSTODY (CLAUDE.md HARD-RULE block) is the single most important invariant in the codebase. parseMerchantXpub is the SOLE chokepoint that enforces it on the Vercel surface.
- Today the only coverage is indirect: `api/test/acceptance/btc-payment.ts` check #5 (`no_custodial`) grep-scans the repo for HR-CUSTODY patterns but does NOT exercise parseMerchantXpub. A regression that quietly accepts an xprv (e.g. a refactor that switches version-set membership) ships green.
- A regression here = ZettaPay holds a key that can sign. That's the ONE thing the product cannot do, ever. The probe is the canary.

Scope (1 new file):

`api/test/acceptance/xpub-rejects-private.ts` exporting a default `(req: VercelRequest, res: VercelResponse) => void` handler that:

1. Rejects GET-with-?_ssr only — accepts `GET` + `HEAD` (returns 200 with same body or empty body for HEAD). Any other method → 405.
2. Imports `parseMerchantXpub, XpubValidationError` from `../../_lib/xpub.js`.
3. Runs ten checks, each wrapped in try/catch and reported as `{ name, ok, code?, message? }`:
     a. `rejects_xprv`     — input: BIP-32 test-vector xprv (`xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi`) — expect XpubValidationError with code `xprv_forbidden`.
     b. `rejects_zprv`     — input: SLIP-132 zprv (canonical test vector — see https://github.com/satoshilabs/slips/blob/master/slip-0132.md table). Expect `xprv_forbidden`.
     c. `rejects_yprv`     — SLIP-132 yprv test vector. Expect `xprv_forbidden`.
     d. `rejects_tprv`     — BIP-32 testnet xprv (`tprv8…`). Expect `xprv_forbidden`.
     e. `rejects_uprv`     — SLIP-132 uprv. Expect `xprv_forbidden`.
     f. `rejects_vprv`     — SLIP-132 vprv. Expect `xprv_forbidden`.
     g. `rejects_garbage`  — input: `"not-a-key"`. Expect XpubValidationError with code `invalid_xpub`.
     h. `rejects_truncated_checksum` — input: valid zpub with the last 6 chars deleted. Expect `invalid_xpub`.
     i. `accepts_valid_zpub` — input: BIP-84 mnemonic-zero zpub (`zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs` — same vector used by btc-payment.ts). Expect parsed.network === 'mainnet'.
     j. `accepts_valid_tpub` — input: BIP-84 testnet tpub canonical vector. Expect parsed.network === 'testnet'.
4. Returns HTTP 200 when every check ok=true, else 503. Body: `{ ok, checks: [{name, ok, code?, message?}, ...] }`.
5. SAFETY: never log the raw input or the parsed HDKey to any sink (no console.log, no Sentry). All errors stay in the response body. The test vectors are public so this is a belt-and-suspenders rule — apply it anyway because it's the right shape for future probes that might use real merchant data.

Constants block at the top of the file: all 10 test vectors as `const` strings, named after their check. Source them from BIP-32 / SLIP-132 test-vector docs only.

Validation:
- `curl https://<preview>/api/test/acceptance/xpub-rejects-private` returns 200 + `{ok: true, checks: [...]}` with exactly 10 entries.
- Flip a single version constant in `api/_lib/xpub.ts` (e.g. remove `xprv` from PRIVATE_VERSIONS) and the probe returns 503 with `rejects_xprv.ok === false`. The probe is the regression detector for HR-CUSTODY.
- `npm run build` passes (the file is auto-detected by Vercel, no config edit needed).
- File line count target: ≤ 200 LOC (mirrors btc-payment.ts shape).
- Wallet-less hard rule: this file IS the enforcement check; do NOT add any `window.solana` / `wallet.connect()` patterns even in comments.
- Brand discipline: no Claude/Anthropic.

Branch: `auto/<uuid>-xpub-acceptance-probe`. Open PR titled `test(api): xpub HR-CUSTODY acceptance probe (rejects every xprv variant)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- ---------------------------------------------------------------------------
-- 4. TEST: BTC confirmation-tier boundary acceptance probe
-- ---------------------------------------------------------------------------
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(api): BTC confirmation-tier boundary probe',
$$Ship `api/test/acceptance/confirmation-tiers.ts` — a public GET probe that exercises `requiredConfirmations()` from `api/_lib/btc-confirmations.ts` at every tier boundary AND every safety-fallback input.

Why this is load-bearing:
- requiredConfirmations is consumed by EVERY BTC invoice creation (api/invoices.ts line 238). A wrong tier directly maps to either financial loss (under-confirming a $500 release at 1 conf risks reorg double-spend) or merchant friction (over-confirming a $5 invoice waits 60+ minutes).
- The tier ladder (<$50: 1, <$500: 3, ≥$500: 6) is documented in CLAUDE.md / mission specs but has NO automated assertion anywhere in the tree. A refactor (e.g. someone "simplifies" the loop into a switch with off-by-one boundaries) ships green.
- The function silently degrades to 6 conf for NaN / Infinity / negative — this is a deliberate safety floor that should be locked in by test.

Scope (1 new file):

`api/test/acceptance/confirmation-tiers.ts` exporting a default `(req: VercelRequest, res: VercelResponse) => void` handler that:

1. Accepts `GET` + `HEAD`; any other → 405.
2. Imports `{ requiredConfirmations, CONFIRMATION_TIERS } from '../../_lib/btc-confirmations.js'`.
3. Runs ten checks, each producing `{ name, input, expected, actual, ok }`:
     a. `zero`            — input: 0 → expected: 6 (safety floor — `amountUsd <= 0` falls into the guard branch).
     b. `one_cent`        — input: 0.01 → expected: 1.
     c. `just_below_50`   — input: 49.99 → expected: 1.
     d. `exactly_50`      — input: 50 → expected: 3 (boundary: strict `<` in the tier loop means $50 falls into the next tier).
     e. `just_below_500`  — input: 499.99 → expected: 3.
     f. `exactly_500`     — input: 500 → expected: 6.
     g. `million`         — input: 1_000_000 → expected: 6.
     h. `nan`             — input: NaN → expected: 6 (Number.isFinite false → safety floor).
     i. `negative`        — input: -1 → expected: 6 (≤0 → safety floor).
     j. `infinity`        — input: Number.POSITIVE_INFINITY → expected: 6.
4. Additionally, assert `CONFIRMATION_TIERS.length === 3` and that the tier sequence is `[{maxUsd:50, confs:1}, {maxUsd:500, confs:3}, {maxUsd:Infinity, confs:6}]` so a structural regression (e.g. someone reorders the array) is caught.
5. Returns 200 when every check + structural assert ok, else 503. Body: `{ ok, checks: [...], tier_table: CONFIRMATION_TIERS }`.

Validation:
- `curl https://<preview>/api/test/acceptance/confirmation-tiers` returns 200 + 10 checks all ok.
- Flip the boundary in `btc-confirmations.ts` (e.g. change `< tier.maxUsd` to `<=`) and the probe returns 503 with `exactly_50.ok === false`. The probe is the regression detector.
- `npm run build` passes.
- File line count target: ≤ 150 LOC.
- Wallet-less hard rule N/A. Brand discipline: no Claude/Anthropic mentions.

Branch: `auto/<uuid>-confirmation-tier-probe`. Open PR titled `test(api): BTC confirmation-tier boundary probe`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- ---------------------------------------------------------------------------
-- 5. TEST: parseEvent() unit coverage in @zettapay/sdk
-- ---------------------------------------------------------------------------
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(sdk): parseEvent() server export unit coverage',
$$Ship `packages/sdk/test/server/events.test.ts` — vitest unit coverage for `parseEvent()` exported from `packages/sdk/src/server/events.ts`.

Why this is load-bearing:
- Z66 (PR #303, 2026-05-27) added `parseEvent()` + `ZettaPayEventSchema` to the `/server` export surface. It's the canonical narrowing seam merchants use to type their webhook payloads (`switch (event.type) { case 'invoice.confirmed': … }`).
- Today `packages/sdk/test/server/` contains only `webhook.test.ts`, which DOES exercise `parseEvent` via one shallow happy-path test that constructs all four event variants and one "throws on unknown event type" test. That is NOT sufficient: the 4-variant Zod discriminated union in `packages/sdk/src/server/types.ts` has nested object shapes, optional `id` envelope field, optional `chain` field on every variant, and a per-variant required-field set — none of those edges are pinned by the current coverage. A regression that silently widens a required field to optional, drops the discriminator literal, or breaks the union ships green.
- The SDK is the public surface of the product (Premissa 23 — "SDK first. @zettapay/sdk em TypeScript canonical"). A typed event union that silently mis-parses is a credibility hit on the first merchant integration.
- Colocating `events.test.ts` next to the existing `webhook.test.ts` mirrors the source layout (`src/server/{events,webhook}.ts` are siblings; `test/server/` should match) and avoids further bloat of `webhook.test.ts` with non-HMAC concerns.

Scope (1 new file in the `packages/sdk` workspace — clean compile lane, NOT packages/api):

`packages/sdk/test/server/events.test.ts` containing a vitest suite that:

1. Imports `parseEvent` + the `ZettaPayEvent` type from `../../src/server/events.js` (use the same relative import shape as the existing `webhook.test.ts` — verify the path with `head packages/sdk/test/server/webhook.test.ts` before writing).
2. Imports `ZodError` from `zod` to assert the throw shape (zod is already a transitive dep of the SDK — verify with `node -e "require('zod')"` inside packages/sdk/).
3. BEFORE writing, run `head packages/sdk/src/server/types.ts` to confirm the actual 4 event variants (`invoice.confirmed`, `invoice.pending`, `invoice.expired`, `invoice.underpaid`) and their per-variant required fields. Mirror the file, NOT the spec, if anything has drifted.

   Covers exactly these cases (one `it()` per case):
     a. `parses canonical invoice.confirmed event` — minimal valid payload with discriminator `invoice.confirmed`; assert `event.type === 'invoice.confirmed'` AND, INSIDE an `if (event.type === 'invoice.confirmed')` guard so TypeScript narrows, reference a field that only exists on confirmed (e.g. `event.data.confirmations` or `event.data.paid_at`). The narrowing read is the compile-time half of the assertion.
     b. `parses canonical invoice.pending event` — same shape for `invoice.pending`; narrow + read `event.data.seen_at`.
     c. `parses canonical invoice.expired event` — same shape for `invoice.expired`; narrow + read `event.data.expired_at`.
     d. `parses canonical invoice.underpaid event` — same shape for `invoice.underpaid`; narrow + read `event.data.received_sats`.
     e. `accepts optional id envelope field` — payload with a string `id`; assert returned event has `id` set.
     f. `accepts optional chain field on data` — payload with `data.chain: 'btc'`; assert preserved.
     g. `throws ZodError on unknown event.type` — payload with `type: 'invoice.nuked'`; assert `error instanceof ZodError`.
     h. `throws ZodError on missing required field` — `invoice.confirmed` payload missing `data.tx_hash`; assert throws.
     i. `throws ZodError on null input` — `parseEvent(null)` throws.
     j. `throws ZodError on string input` — `parseEvent('not-json')` throws.
     k. `narrows discriminated union exhaustively` (compile-time check) — exhaustive switch over `event.type` with the `default:` branch typed as `never` via a `_exhaustive: never = event` assignment. This locks the union cardinality at COMPILE time; adding a new variant without updating the switch trips `tsc --noEmit`.

4. Run from packages/sdk via `npm test -w @zettapay/sdk` — vitest auto-discovers `packages/sdk/test/**/*.test.ts`.

Validation:
- `cd packages/sdk && npm test` — new suite runs, all cases pass.
- Manually break `ZettaPayEventSchema` (e.g. change `invoice.confirmed` literal to `invoice.confirm`) and rerun; expect cases (a) + (g) + (k) to fail. Revert the deliberate break before commit.
- `npm run build` (root) passes — the test is in the existing sdk vitest config, no new tooling.
- File line count target: ≤ 150 LOC.
- Wallet-less hard rule N/A — pure schema test.
- Brand discipline: no Claude/Anthropic mentions.

Out of scope:
- Adding a `parseSignedEvent` (verify + parse) helper — separate mission.
- Property-based / fuzz testing — separate mission.

Branch: `auto/<uuid>-sdk-parse-event-test`. Open PR titled `test(sdk): parseEvent() unit coverage`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- ---------------------------------------------------------------------------
-- Audit row — record the auto-regen execution with the 5 inserted mission ids.
-- ---------------------------------------------------------------------------
-- The orchestrator (or operator) running this file in a transaction will see
-- the 5 newly-inserted mission rows. We capture their ids via a sentinel
-- SELECT and emit a single audit row referencing them.
INSERT INTO fabric_audit_journal
  (event_type, payload, created_at)
SELECT
  'auto_regen_executed',
  jsonb_build_object(
    'source_mission_uuid_prefix', '291b8665',
    'workspace_id', 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
    'workspace_slug', 'zettapay',
    'companion_md', 'docs/discovery/291b8665-backlog-refill.md',
    'companion_sql', 'docs/discovery/291b8665-backlog-refill.sql',
    'mission_count', count(*),
    'mission_ids', jsonb_agg(id ORDER BY name),
    'mission_names', jsonb_agg(name ORDER BY name)
  ),
  now()
FROM fabric_squad_missions
WHERE workspace_id = 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b'
  AND source = 'auto-regen'
  AND name IN (
    'sec(api): bearer-token gate on internal/webhooks/test',
    'sec(api): bearer-token gate on internal/listener/status',
    'test(api): xpub HR-CUSTODY acceptance probe',
    'test(api): BTC confirmation-tier boundary probe',
    'test(sdk): parseEvent() server export unit coverage'
  )
  AND created_at >= now() - interval '5 minutes';

COMMIT;
