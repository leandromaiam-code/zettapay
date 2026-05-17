-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: c3f319e1
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/c3f319e1-backlog-refill.md
--
-- All 5 picks are single-file, single-objective, additive, outside the
-- chronic-broken packages/api compile lane, wallet-less-compliant, and
-- distinct from prior refills (843972bd, c08a7f17, 07b1ae9c, 03cf9a17,
-- e365137f, 66b549af, d5806497, bf6837e4, 9db4cb78, a82d92db, 1986ee3d,
-- 2e05f052, 4f79ec06, 69cdcbce, fba46358 — 15 prior passes scanned).
--
-- Themes covered this pass:
--   1. CANONICAL TS SDK public re-export surface stability test — the
--      widget version of this test is queued in 843972bd and the embed
--      companion is Pick #4 this pass; the TS SDK (Premissa 23: canonical
--      polyglot family member with ~95 named exports across 9 internal
--      modules) deserves the same regression-catch. No behavioral
--      assertions — only shape-locking. Catches silent drops on refactor.
--   2. docs/concepts/idempotency-keys.mdx — merchant-facing concept
--      doc for Premissa 10 (Idempotency keys obrigatórios em /pay e
--      /merchants/register). docs/api-reference/idempotency.mdx exists
--      but is technical reference; the WHY-to-set-the-header layer is
--      missing.
--   3. docs/guides/poll-payment-completion.mdx — canonical guide for
--      the poll-as-fallback (or poll-as-primary for CLI/cron flows)
--      integration pattern. The webhook path has 4 docs across guides/
--      + guides/webhooks/; the poll path has zero. Exponential backoff
--      + idempotent write-side + rate-limit awareness + webhook-first
--      preference all documented in one page.
--   4. packages/embed/test/index.test.ts — embed companion to the
--      widget surface-stability test queued in 843972bd. The 843972bd
--      doc explicitly deferred this until the widget pattern proves
--      out; this pass unblocks it. Locks 13 re-exported names + the
--      auto-init no-op contract (zero side effects when host page has
--      no script[data-recipient][data-amount]).
--   5. docs/concepts/compliance.mdx — public-facing concept page for
--      Premissa 17 (KYC apenas via MoonPay onramp. Não somos MSB).
--      Today this load-bearing posture lives only in CLAUDE.md. The
--      "non-MSB / non-custodial" stance determines onboarding, fees,
--      and the licensing footprint we don't need; merchants evaluating
--      ZettaPay need a citable source.
--
-- Repeat-rejection themes AVOIDED in this refill (each rejected 2+
-- times by prior reviewers): CHANGELOG.md (release-ops decision),
-- per-SDK CHANGELOG.md, CODEOWNERS, FUNDING.yml, CODE_OF_CONDUCT.md,
-- public/manifest.json PWA shell, public/favicon.*, aggressive
-- CSP/HSTS/X-Frame-Options, packages/sdk/examples/quickstart.ts
-- (@solana/web3.js bundling decision — REJECTED IN #258, #259, #263).
-- Dependency-blocked picks deferred: packages/sdk-php/tests/Webhook*
-- (source verifier queued in 1986ee3d but not yet shipped),
-- packages/sdk-go/examples/poll.go + packages/sdk-python/examples/poll.py
-- (sdk-go examples/ dir does not exist yet; sdk-python webhook example
-- queued in c08a7f17 should ship before companion poll example).
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are
-- the canonical payload the orchestrator (or a human operator with
-- the service-role key) should apply on merge. All inserts are
-- deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. TS SDK — index.ts public re-export surface stability test
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(sdk): index.ts public re-export surface stability',
$$Add `packages/sdk/test/index.test.ts` — a vitest spec that locks the public re-export surface of `packages/sdk/src/index.ts` (the canonical `@zettapay/sdk` entry point) against accidental rename / removal. Today the TS SDK re-exports ~95 named symbols across nine internal modules (`client`, `errors`, `types`, `onchain`, `idl/zettapay`, `helpers`, `solana-pay`, `derive`, `webhook`) — verified by `cat packages/sdk/src/index.ts` — but `packages/sdk/test/` currently has only module-level tests (`derive.test.ts`, `errors.test.ts`, `helpers.test.ts`, `onchain.test.ts`, `solana-pay.test.ts`, `webhook.test.ts`). NONE asserts the shape of the public re-export surface. A future internal refactor that renames `ZETTAPAY_PROGRAM_ID` or drops `parseWebhook` from the index re-export ships silently.

Why this is fresh:
- `packages/widget/test/index.test.ts` (queued in pass 843972bd, PR #263) is the SAME pattern but for the WIDGET package (3 fns + 7 type re-exports — much smaller surface).
- `packages/embed/test/index.test.ts` is Pick #4 in THIS pass — same pattern for the EMBED package.
- `packages/sdk/test/client.test.ts` (queued in pass 03cf9a17, PR #260) tests the `client.ts` MODULE, not the index re-export.
- `packages/sdk/test/derive.test.ts` + sibling per-module tests cover module internals, not the public re-export surface.

The CANONICAL TS SDK (Premissa 23: `@zettapay/sdk` em TypeScript canonical) is the highest-stakes surface in the polyglot SDK family; it deserves at least the same regression-catch we just queued for the widget.

Premissa 23 (SDK-first, TS canonical), Premissa 27 (Quality Gate: missions <30 score blocked, ≥60 auto-approve), Premissa 29 (Tech debt @ts-nocheck só permitido em código legacy — the regression-catch prevents @ts-nocheck workarounds downstream when a re-export drops).

Public surface to lock (read `packages/sdk/src/index.ts` BEFORE writing — this list MUST match what is CURRENTLY exported; if anything has drifted between this spec and the actual file, mirror the file, not the spec):

Functions exported at the root:
- From `./client.js`: `ZettaPayClient` (class, typeof === 'function').
- From `./errors.js`: `ZettaPayError` (class), `fromAxiosError` (function).
- From `./onchain.js`: `resolveCluster`, `isValidMerchantHandle`, `deriveMerchantBindingPda`, `derivePaymentPda`, `deriveInvoicePda`, `deriveAssociatedTokenAddress`, `deriveInvoiceUsdcAddress`, `buildRegisterMerchantInstruction`, `buildRecordPaymentInstruction`, `registerMerchantOnChain`, `recordPayment`.
- From `./helpers.js`: `createMerchant`, `createInvoice`, `ensureInvoiceUsdcAta`, `getInvoiceStatus`, `isInvoiceExpired`, `listenPaymentEvents`, `sweep`.
- From `./solana-pay.js`: `buildZettaPayUri`, `parseZettaPayUri`, `buildSolanaPayUri`, `generateInvoiceQrSvg`, `generateInvoiceQrDataUrl`.
- From `./derive.js`: `deriveAddress`, `deriveBitcoinAddress`, `deriveEthereumAddress`, `deriveUsdcAddress`.
- From `./webhook.js`: `parseWebhook`, `dedupe`, `MemoryEventStore` (class).

Constants exported at the root:
- From `./client.js`: `X402_HEADER` (string).
- From `./onchain.js`: `ZETTAPAY_PROGRAM_ID` (string), `MERCHANT_HANDLE_MIN_LEN` + `MERCHANT_HANDLE_MAX_LEN` + `PAYMENT_ID_LEN` + `TX_SIGNATURE_LEN` + `INVOICE_INDEX_SEED_LEN` (numbers), `TOKEN_PROGRAM_ID` + `ASSOCIATED_TOKEN_PROGRAM_ID` + `USDC_MINT` + `SOLANA_RPC_URL` + `DEFAULT_CLUSTER` + `DEFAULT_SOLANA_RPC_URL` (strings).
- From `./idl/zettapay.js`: `ZETTAPAY_IDL` (object).
- From `./helpers.js`: `USDC_MAINNET_MINT` + `USDC_DEVNET_MINT` (strings), `USDC_DECIMALS` (number).
- From `./solana-pay.js`: `ZETTAPAY_URI_SCHEME` + `SOLANA_PAY_URI_SCHEME` + `DEFAULT_CURRENCY` (strings).
- From `./webhook.js`: `SIGNATURE_HEADER` + `TIMESTAMP_HEADER` + `EVENT_ID_HEADER` + `ATTEMPT_HEADER` (strings).

Type-only re-exports are NOT directly testable at runtime (types are erased) — the typecheck step on the test file IS the assertion that the type re-exports still resolve. Do NOT add `expectTypeOf` assertions for the type-only exports (that would add a `vitest` dep on `expectTypeOf` runtime support and balloon the file); the implicit `import type { ... }` in the test header is sufficient.

Scope (1 new file, ~100-140 LOC):

1. Create `packages/sdk/test/index.test.ts`.
2. Vitest config (`packages/sdk/vitest.config.ts`) sets a node-equivalent env — no DOM scaffolding needed.
3. Top-level static `import { ... } from '../src/index.js';` — list ALL the function + constant names above. Optionally a single `import type { ApiErrorBody, HealthStatus, ListMerchantsOptions, ListMerchantsResponse, ListPaymentsOptions, ListPaymentsResponse, Merchant, PayResponse, PaymentRecord, RegisterMerchantInput, UpdateMerchantInput, PdaAddress, UsdcCluster, ZettaPayErrorCode, BitcoinNetwork, DerivedAddress, DerivedChain, ParseWebhookOptions, ParseWebhookResult, ParsedWebhook, WebhookFailureReason, EventStore, DedupeResult, HeaderBag, CreateMerchantParams, CreateMerchantResult, CreateInvoiceParams, EnsureInvoiceUsdcAtaParams, EnsureInvoiceUsdcAtaResult, Invoice, InvoiceStatus, InvoiceStatusReceipt, InvoiceStatusResult, GetInvoiceStatusParams, ListenPaymentEventsParams, PaymentEvent, PaymentSubscription, SweepParams, SweepResult, BuildZettaPayUriParams, ParsedZettaPayUri, BuildSolanaPayUriParams, InvoiceQrOptions, DeriveAddressParams, DeriveBitcoinAddressParams, DeriveEthereumAddressParams, DeriveInvoiceUsdcAddressParams, InvoiceUsdcAddress, BuildRegisterMerchantParams, BuildRecordPaymentParams, RegisterMerchantOnChainParams, RecordPaymentOnChainParams, SendOnChainResult, ZettaPayClientOptions, PayInput } from '../src/index.js';` — verify exact names against `src/index.ts` BEFORE writing; if a type is missing or renamed, mirror the actual file. The type import gives the `tsc --noEmit` step a compile-time assertion that all type re-exports still resolve.
4. ONE `describe('@zettapay/sdk public surface', ...)` block with three nested `describe` blocks:
   - `describe('functions', ...)` — drive the assertions from a `Record<string, unknown>` table: `const funcs = { ZettaPayClient, fromAxiosError, resolveCluster, isValidMerchantHandle, deriveMerchantBindingPda, derivePaymentPda, deriveInvoicePda, deriveAssociatedTokenAddress, deriveInvoiceUsdcAddress, buildRegisterMerchantInstruction, buildRecordPaymentInstruction, registerMerchantOnChain, recordPayment, createMerchant, createInvoice, ensureInvoiceUsdcAta, getInvoiceStatus, isInvoiceExpired, listenPaymentEvents, sweep, buildZettaPayUri, parseZettaPayUri, buildSolanaPayUri, generateInvoiceQrSvg, generateInvoiceQrDataUrl, deriveAddress, deriveBitcoinAddress, deriveEthereumAddress, deriveUsdcAddress, parseWebhook, dedupe };` then `Object.entries(funcs).forEach(([name, ref]) => it(\`exports \${name} as a function\`, () => expect(typeof ref).toBe('function')));`. This keeps the file ≤140 LOC even with ~30 function assertions.
   - `describe('classes', ...)` — `it('exports ZettaPayError as a constructable Error subclass', () => { const e = new ZettaPayError({ message: 'x', status: 500 }); expect(e).toBeInstanceOf(Error); });` (verify exact ZettaPayError constructor signature against `src/errors.ts` BEFORE writing). `it('exports MemoryEventStore as a class', () => { const s = new MemoryEventStore(); expect(typeof s.has).toBe('function'); expect(typeof s.add).toBe('function'); });` (verify exact `MemoryEventStore` method names against `src/webhook.ts` BEFORE writing).
   - `describe('constants', ...)` — drive from another table, this time split by expected type: `const stringConsts = { X402_HEADER, ZETTAPAY_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, USDC_MINT, SOLANA_RPC_URL, DEFAULT_CLUSTER, DEFAULT_SOLANA_RPC_URL, USDC_MAINNET_MINT, USDC_DEVNET_MINT, ZETTAPAY_URI_SCHEME, SOLANA_PAY_URI_SCHEME, DEFAULT_CURRENCY, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER, ATTEMPT_HEADER };` + `const numberConsts = { MERCHANT_HANDLE_MIN_LEN, MERCHANT_HANDLE_MAX_LEN, PAYMENT_ID_LEN, TX_SIGNATURE_LEN, INVOICE_INDEX_SEED_LEN, USDC_DECIMALS };` + `it('exports ZETTAPAY_IDL as an object', () => expect(typeof ZETTAPAY_IDL).toBe('object'));`. Loop both tables with `Object.entries(...).forEach(...)`.
5. NO behavioral assertions (no calling `client.pay()`, no constructing real wallets, no Solana network connection). This test ONLY locks the SHAPE — names exist, types are correct (function vs class vs string vs number vs object). Behavior is covered by the existing per-module tests + queued `client.test.ts`.
6. NO assertion on constant VALUES (e.g. `expect(X402_HEADER).toBe('X-402')`) — that's a behavioral / wire-protocol assertion belonging in `client.test.ts`.
7. Do NOT modify `src/index.ts` or any source file.

Validation:
- `cd packages/sdk && npx vitest run test/index.test.ts` passes all assertions.
- `cd packages/sdk && npx vitest run` (full SDK test suite) passes — zero regressions.
- `cd packages/sdk && npx tsc --noEmit` clean (the static type imports are the type-re-export assertion).
- `npm run build` unaffected — test files outside `tsconfig.build.json` allow-list (worker memory `feedback_tsconfig_build_allowlist.md`).
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/sdk/test/index.test.ts` returns ZERO. Surface-shape assertions only.
- Brand discipline: no Claude/Anthropic mentions in the file or commit. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-index-surface-test`. Open PR titled `test(sdk): lock public re-export surface (~95 named exports)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. docs/concepts/idempotency-keys.mdx — merchant-facing concept doc
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(concepts): idempotency-keys merchant concept page',
$$Add `docs/concepts/idempotency-keys.mdx` — the canonical merchant-facing concept page explaining the WHY and WHEN of the `X-Idempotency-Key` header on `/pay` and `/merchants/register`. Today `docs/api-reference/idempotency.mdx` exists (verified: `ls docs/api-reference/`) and documents the technical surface (header name, response shape, 409 collision rule), but the merchant-facing concept layer (why merchants set the header in the first place — retry-safe payment creation, network blip recovery, duplicate-charge prevention) is undocumented at `docs/concepts/`.

Current `docs/concepts/` inventory (verified): architecture, ai-agents, native-integrations, webhooks, onramp, beta-launch (+ wallet-less queued in pass 843972bd, PR #263). NO idempotency-keys.mdx.

Premissa 10 (Idempotency keys obrigatórios em /pay e /merchants/register — Z8.3 — this is one of only 4 reliability premissas in Layer 0), Premissa 24 (Documentation site mintlify-style — Z17. Critical for adoption).

Scope (1 new file, ~100-150 LOC mdx):

1. Create `docs/concepts/idempotency-keys.mdx`.
2. Frontmatter (matches sibling concept docs — read `docs/concepts/webhooks.mdx` FIRST; confirmed shape is `title:` + `description:` — no extra keys):
   ```
   ---
   title: "Idempotency keys"
   description: "Retry-safe /pay and /merchants/register via the X-Idempotency-Key header — no duplicate charges, even when the network blips."
   ---
   ```
3. Body sections (use mintlify-flavored MDX components only if sibling docs already use them — `docs/concepts/webhooks.mdx` uses plain markdown tables, no `<Card>` / `<Steps>`; mirror that style):

   - **What it protects against** (3-5 paragraphs):
     - Network blip during `POST /pay` — your code retries but the original transfer already succeeded; without an idempotency key, the customer is double-charged.
     - Dashboard double-click — merchant clicks "Send" twice in 200ms; both reach the API; without the key, both go through.
     - Cron job re-run after crash — the cron retries unfinished work; without the key, payments that completed but didn't get persisted locally get processed twice.
     - Queue worker retry storm — same logic at a larger scale.

   - **How to construct the key** (bulleted list):
     - UUIDv4 generated server-side and stored in your database BEFORE issuing the call (so a crash between generation and call doesn't lose the key).
     - Never a client-supplied value — clients can replay arbitrary keys and confuse your dedupe.
     - SHOULD be unique per logical attempt — one shopping-cart checkout = one key, even across all retries of THAT checkout. Two different carts = two different keys.
     - Never reuse across DIFFERENT request bodies — collision returns `409 idempotency_key_conflict`.

   - **What ZettaPay does** (numbered list):
     1. Reads `X-Idempotency-Key` header on `/pay` and `/merchants/register` (verify exact endpoint list against `packages/api/src/` BEFORE writing).
     2. Looks up `(merchant_id, idempotency_key)` in the dedupe store (Postgres, per Premissa 13).
     3. If hit AND request body matches: returns the original response verbatim, no side effects. Status code from the original is replayed.
     4. If hit AND request body differs: returns `409 idempotency_key_conflict` with the conflicting field list.
     5. If miss: processes the request normally and persists `(merchant_id, key, response_body, status_code)` for 24 hours.

   - **Relationship to webhook idempotency** (1 paragraph): cross-link to `/concepts/webhooks` — the `X-ZettaPay-Event-Id` header on inbound webhook deliveries is the INVERSE direction's idempotency primitive (we dedupe webhook deliveries on YOUR end the same way you dedupe `/pay` calls on OUR end). Two sides of the same problem. Cross-link to `/guides/handling-webhooks` for the inbound side.

   - **Code snippets** (one TS SDK example + one curl example):
     - TS SDK: read `packages/sdk/src/client.ts` `PayInput` type BEFORE writing — if `idempotencyKey` is on the type, use `client.pay(tx, { idempotencyKey: 'order-' + cartId })`. If NOT on the type (likely — verify), fall back to raw fetch: `fetch(\`\${baseURL}/pay\`, { headers: { 'X-Idempotency-Key': key, 'Content-Type': 'application/json', ... } })`.
     - curl: `curl -X POST $BASE/pay -H "X-Idempotency-Key: $(uuidgen)" -H "Content-Type: application/json" -d '{...}'`.
     - NO Python / Go / PHP SDK examples — those SDKs may not expose `idempotencyKey` on their input types yet, and adding examples that may not work risks doc/code drift. Leave for a future per-SDK doc-parity mission.

4. Do NOT modify `docs/docs.json` — sidebar registration is deferred to a separate trivial mission (1-line array insert) to keep this pass strictly single-file. The page is still routable at `/concepts/idempotency-keys` on direct navigation; mintlify renders it.
5. Do NOT touch any other file. No README updates, no api-reference cross-link edits, no `idempotency.mdx` rename.

Validation:
- `npm run docs:check` (if `mint` CLI installs cleanly) reports no broken links FROM this page. Broken links INTO this page are expected (sidebar not registered yet — separate mission).
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/concepts/idempotency-keys` if launched locally.
- `npm run build` unaffected — mdx files outside the TS build.
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric. NO forbidden Veridian brand words ("revolution"/"disruption"/"synergy"/"game-changer").

Branch: `auto/<uuid>-concepts-idempotency-keys`. Open PR titled `docs(concepts): idempotency-keys merchant concept page`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. docs/guides/poll-payment-completion.mdx — polling integration guide
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(guides): poll-payment-completion fallback guide',
$$Add `docs/guides/poll-payment-completion.mdx` — the canonical guide for the poll-as-fallback (or poll-as-primary for CLI/cron/serverless flows) integration pattern. Today the webhook path is exhaustively documented (`docs/guides/handling-webhooks.mdx` + sub-dir `docs/guides/webhooks/{best-practices,replay,signing-examples}.mdx` = 4 docs), but the POLL path — the canonical fallback when webhook deliveries are delayed past your UX threshold, OR the canonical primary path for flows that don't want to expose a webhook URL (CLI tools, cron jobs, serverless cold-start flows) — has NO guide at all.

Current `docs/guides/` inventory (verified): `accept-payments`, `devnet-faucet`, `drop-in-integrations`, `handling-webhooks`, `mcp-integration`, `x402-protocol` + sub-dirs `integrations/{anthropic,huggingface,openai}`, `tutorials/{ai-agent-payments,fraud-rules,recurring-billing,shopify}`, `webhooks/{best-practices,replay,signing-examples}`. NO poll-* guide.

Premissa 9 (Webhooks Stripe-grade — 3x retry exponential, signature verification, idempotency — Z10. Webhooks are CANONICAL but not 100% reliable; merchants need a documented fallback when delivery exceeds the retry envelope), Premissa 24 (Documentation site mintlify-style — Z17).

Scope (1 new file, ~130-180 LOC mdx):

1. Create `docs/guides/poll-payment-completion.mdx`.
2. Frontmatter (matches sibling guide docs — read `docs/guides/handling-webhooks.mdx` FIRST):
   ```
   ---
   title: "Poll payment completion"
   description: "When webhooks aren't an option: idempotent polling of GET /payments/:id with exponential backoff."
   ---
   ```
3. Body sections (mintlify components only if sibling docs use them — `handling-webhooks.mdx` uses `<CardGroup>` + `<Card>`; mirror sparingly):

   - **When to poll** (3 bullet paragraphs):
     - No public webhook URL: CLI tool, cron job, serverless cold-start flow, on-prem worker behind a NAT.
     - Webhook handler is currently down: your endpoint is returning 5xx; ZettaPay retries (3x exponential per Premissa 9) but eventually exhausts; polling is the recovery path.
     - Webhook delivery exceeds your UX deadline: you want to show "confirming…" → "paid" in <10s on a checkout page; webhooks deliver in 1-5s typical but tail latency can stretch to 30s+; polling lets the UI confirm faster than the worst-case webhook tail.

   - **The polling loop** (numbered list, 6 steps):
     1. After `POST /pay` returns the `payment_id`, start a polling loop.
     2. Sleep for an initial backoff (suggest 2 seconds).
     3. Call `GET /payments/{payment_id}` (verify exact endpoint shape against `packages/api/src/routes/payments.ts` or similar BEFORE writing).
     4. On status `pending`: sleep with exponential backoff (suggest `2 * 1.5 ^ attempt` capped at 30 seconds, jittered ±20% to avoid thundering herd) and repeat.
     5. On status `confirmed`: persist locally + return to caller.
     6. On wall-clock deadline (suggest 5 minutes): give up, mark order as "awaiting confirmation", reconcile manually via a daily cron that re-polls outstanding payments.

   - **Code snippet** (one TypeScript example using the SDK):
     ```typescript
     async function pollPayment(
       client: ZettaPayClient,
       paymentId: string,
       opts: { deadlineMs?: number; signal?: AbortSignal } = {}
     ): Promise<PaymentRecord> {
       const deadline = Date.now() + (opts.deadlineMs ?? 5 * 60_000);
       let backoff = 2_000;
       while (Date.now() < deadline) {
         if (opts.signal?.aborted) throw new Error('aborted');
         const record = await client.getPayment(paymentId);
         if (record.status === 'confirmed') return record;
         const jitter = backoff * (0.8 + Math.random() * 0.4);
         await new Promise(r => setTimeout(r, jitter));
         backoff = Math.min(backoff * 1.5, 30_000);
       }
       throw new Error('poll deadline exceeded — reconcile manually');
     }
     ```
     Verify `client.getPayment(id)` returns a `PaymentRecord` with a `status: 'pending' | 'confirmed' | 'failed' | ...` field by reading `packages/sdk/src/types.ts` BEFORE writing; if the actual status enum differs, mirror the actual values in the snippet AND in the conditional.

   - **Idempotency on YOUR side** (1 paragraph): polling is idempotent on the read side, but the merchant's REACTION (shipping the order, emailing the receipt, fulfilling the digital good) must be idempotent on the write side — same `X-Idempotency-Key` discipline as webhook handlers. Cross-link to `/concepts/idempotency-keys` (queued as Pick #2 in this same pass `c3f319e1`) and `/guides/webhooks/best-practices`.

   - **Rate-limit awareness** (1 paragraph): the polling loop respects the per-API-key rate limit (Premissa 11). The 2s + exponential backoff naturally stays well under any sliding-window cap. Merchants polling hundreds of payments concurrently SHOULD batch (one cron pass that reads outstanding `payment_id`s from your DB, polls each, and bails on the first rate-limit 429 + retries with a longer backoff). If a batch endpoint exists (verify `GET /payments?ids=...` against the API surface BEFORE writing), reference it; if not, document the per-key concurrency cap and the recommended sequential poll cadence.

   - **Webhook-first preference** (final 1 paragraph): cross-link to `/guides/handling-webhooks` — polling is the FALLBACK, not the canonical path. Webhooks deliver faster (1-5s typical vs poll's 2s minimum cadence), cost less in API quota, and signal liveness when your handler ACKs. Use polling when webhooks aren't an option, not as the default.

4. Do NOT modify `docs/docs.json` — sidebar registration is deferred to a separate trivial mission.
5. Do NOT touch any other file. No README updates, no sitemap edits, no broken-link sweeps.

Validation:
- `npm run docs:check` reports no broken links FROM this page. Broken links INTO this page expected (sidebar not registered yet).
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/guides/poll-payment-completion` if launched locally.
- `npm run build` unaffected.
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-guides-poll-payment-completion`. Open PR titled `docs(guides): poll-payment-completion fallback guide`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. embed — public re-export + auto-init no-op surface stability test
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(embed): index.ts public re-export surface stability',
$$Add `packages/embed/test/index.test.ts` — a vitest spec that locks the public re-export surface of `packages/embed/src/index.ts` (the canonical `@zettapay/embed` drop-in entry point) against accidental rename / removal AND locks the auto-init no-op contract (zero side effects when the host page does not opt in via `script[data-recipient][data-amount]`). Today `packages/embed/test/` has `embed.test.ts` + `wallets.test.ts` and the queued companions `poll.test.ts` (pass 2e05f052, PR #245) and `rpc.test.ts` (pass 07b1ae9c, PR #261) — but NOTHING that locks the `index.ts` re-export shape or the auto-init contract.

The 843972bd rationale doc (PR #263) explicitly DEFERRED this surface with the note: "the embed `index.ts` is significantly larger (auto-init, mount, re-export from 4 sibling modules) and a stability test of comparable depth would balloon past the single-objective bar. Queue separately once the widget test has shipped and we know the shape works." With the widget version queued and the auto-init guard pattern (clear `document.body` + `vi.resetModules()` dynamic re-import) proven viable, the embed companion becomes the next unblocked single-objective pick.

`packages/embed/src/index.ts` is 121 LOC (verified by `wc -l packages/embed/src/index.ts`) and re-exports the following from 4 sibling modules (verify against the actual file BEFORE writing; if names have drifted, mirror the file):
- From `./embed.js`: `mount` (function), `buildSolanaPayUri` (function), `resolveCluster` (function), `toBaseUnits` (function).
- From `./poll.js`: `matchesTransfer` (function).
- From `./rpc.js`: `RPC_URL` (string), `USDC_MINT` (string).
- From `./wallets.js`: `WALLETS` (object — wallet registry map), `buildWalletDeeplink` (function), `detectWallets` (function), `getWalletMeta` (function), `isMobile` (function).
- Locally: `version` (string).
- Type re-exports from `./types.js`: `Cluster`, `EmbedConfig`, `EmbedSuccessEvent`, `EmbedErrorEvent`, `EmbedHandle`, `EmbedPostMessage`, `WalletDetection`, `WalletId`, `WalletMeta`.

Note: the `WALLETS` / `detectWallets` / `buildWalletDeeplink` exports are READ-ONLY wallet-standard detection helpers per the wallet-less HARD-rule ("what we DO support" — `wallet-standard` for DETECTING wallets, NOT `wallet.connect()`). The test exercises only the export SHAPE, not any `connect()` flow.

Premissa 23 (SDK-first, embed is the canonical drop-in surface for Z14 widget family), Premissa 27 (Quality Gate), Premissa 29 (zero @ts-nocheck in new code).

Scope (1 new file, ~70-110 LOC):

1. Create `packages/embed/test/index.test.ts`.
2. Vitest config check: verify `packages/embed/vitest.config.ts` sets `environment: 'happy-dom'` BEFORE writing. If yes, the auto-init no-op test runs as-is. If no, the auto-init test must guard on `typeof document !== 'undefined'` and skip with a `it.skip(...)` when the env is bare-node.
3. Test cases (one `describe('@zettapay/embed public surface', ...)` block with three nested `describe`s):
   - `describe('functions', ...)` — drive from a `Record<string, unknown>` table: `const funcs = { mount, buildSolanaPayUri, resolveCluster, toBaseUnits, matchesTransfer, buildWalletDeeplink, detectWallets, getWalletMeta, isMobile };` then `Object.entries(funcs).forEach(([name, ref]) => it(\`exports \${name} as a function\`, () => expect(typeof ref).toBe('function')));`.
   - `describe('constants', ...)` — `it('exports version as a non-empty string', () => { expect(typeof version).toBe('string'); expect(version.length).toBeGreaterThan(0); });` — `it('exports RPC_URL as an https URL', () => { expect(typeof RPC_URL).toBe('string'); expect(RPC_URL).toMatch(/^https?:\/\//); });` — `it('exports USDC_MINT as a base58-shaped string', () => { expect(typeof USDC_MINT).toBe('string'); expect(USDC_MINT.length).toBeGreaterThanOrEqual(32); expect(USDC_MINT.length).toBeLessThanOrEqual(44); });` — `it('exports WALLETS as a non-empty object', () => { expect(typeof WALLETS).toBe('object'); expect(WALLETS).not.toBeNull(); expect(Object.keys(WALLETS).length).toBeGreaterThan(0); });`.
   - `describe('auto-init', ...)` — `it('is a no-op when no script[data-recipient][data-amount] tags are present', async () => { document.body.innerHTML = ''; vi.resetModules(); await import('../src/index.js'); expect(document.querySelectorAll('[data-zettapay-embed-target]').length).toBe(0); });`. This locks the AUTO-INIT CONTRACT — zero side effects when the host page does not opt in. NOTE: the embed module's auto-init waits for `DOMContentLoaded` if `document.readyState === 'loading'` (see `src/index.ts` line 113); the test runs in happy-dom which reports `readyState === 'complete'` by default, so the auto-init callback fires synchronously on import. If the test flakes (auto-init not yet fired), add a `await new Promise(r => setTimeout(r, 0))` between import and assertion.
4. Use TOP-LEVEL static imports for the function + constant tests; use dynamic re-import (after `vi.resetModules()`) ONLY for the auto-init test where the side-effect surface matters.
5. Do NOT test `mount(target, config)` BEHAVIOR (DOM rendering, RPC polling, payment confirmation) — that's `embed.test.ts` + the queued `poll.test.ts` + `rpc.test.ts` jobs. THIS test ONLY locks the SHAPE of the public surface + the auto-init no-op contract.
6. Do NOT modify `src/index.ts` or any other source file.

Validation:
- `cd packages/embed && npx vitest run test/index.test.ts` passes all cases.
- `cd packages/embed && npx vitest run` (full embed test suite) passes — no regressions to `embed.test.ts` or `wallets.test.ts`.
- `npm run build --workspace @zettapay/embed` unaffected.
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/embed/test/index.test.ts` returns ZERO. The `WALLETS` / `detectWallets` / `buildWalletDeeplink` references are read-only wallet-standard detection per the HARD-rule "what we DO support" section.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-index-surface-test`. Open PR titled `test(embed): lock public re-export surface + auto-init no-op contract`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. docs/concepts/compliance.mdx — KYC via MoonPay, not MSB
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(concepts): compliance — KYC via MoonPay, not MSB',
$$Add `docs/concepts/compliance.mdx` — the canonical public concept page for Premissa 17 ("Compliance: KYC apenas via MoonPay onramp. Não somos MSB."). Today this load-bearing posture lives ONLY in CLAUDE.md and is invisible to merchants and integrators evaluating ZettaPay. The "we are non-custodial and not a money services business" stance determines the entire onboarding posture, the KYC delegation pattern, and the licensing footprint we DON'T need (no money-transmitter license per US state, no e-money license in EU).

Current `docs/concepts/` inventory (verified): architecture, ai-agents, native-integrations, webhooks, onramp, beta-launch (+ wallet-less queued in pass 843972bd PR #263). NO compliance.mdx.

Closest existing docs:
- `docs/concepts/onramp.mdx` — covers the MoonPay onramp from a UX angle (how customers fund USDC), NOT from a compliance angle (why MoonPay handles KYC, not ZettaPay).
- `docs/concepts/architecture.mdx` — references compliance tangentially; not a canonical home.
- `audit/SCOPE.md`, `audit/SECURITY_ASSUMPTIONS.md`, `audit/THREAT_MODEL.md` — internal audit docs, not public-facing.

Premissa 17 (Compliance: KYC apenas via MoonPay onramp. Não somos MSB — one of only 4 security & compliance premissas in Layer 0), Premissa 24 (Documentation site mintlify-style — critical for adoption).

Scope (1 new file, ~100-160 LOC mdx):

1. Create `docs/concepts/compliance.mdx`.
2. Frontmatter (matches sibling concept docs):
   ```
   ---
   title: "Compliance"
   description: "ZettaPay is non-custodial and not a money services business. KYC is delegated to the MoonPay onramp."
   ---
   ```
3. Body sections:

   - **Non-custodial by construction** (2 paragraphs): cross-link to `/concepts/wallet-less` (queued in `843972bd`, PR #263). ZettaPay never holds USDC at any moment — every payment is a direct on-chain transfer `payer → merchant`. There is no custody surface, no withdrawal queue, no commingled treasury, no rehypothecation risk. The wallet-less HARD-rule ("ZettaPay NUNCA requer conectar carteira") guarantees the architecture cannot drift toward custody by accident.

   - **Not a money services business** (3 paragraphs):
     - Non-custody + non-fiat + no on-chain holding does NOT meet the FinCEN definition of an MSB (Money Services Business) under 31 CFR 1010.100(ff). We do not "accept and transmit funds" in the regulatory sense — we facilitate direct on-chain transfers between counterparties.
     - We therefore do NOT require state-by-state Money Transmitter Licensing (MTL) in the US. We do not require an e-money license in the EU under PSD2. We do not require BSP / VASP registration in jurisdictions whose regimes specifically target custodial flows.
     - **Regulatory posture differs by jurisdiction and evolves quickly. Check with your own counsel before launching in any specific market.** (CRITICAL hedge — do NOT make absolute regulatory claims.)

   - **Where KYC actually happens** (2 paragraphs): cross-link to `/concepts/onramp`. MoonPay (our fiat→USDC ramp partner) is a registered MSB / VASP in the jurisdictions it operates in and handles KYC on the fiat side. Merchants whose customers BYO USDC (crypto-native) bypass KYC entirely — there's no fiat on-ramp event to trigger it. Merchants using MoonPay-funded customers inherit MoonPay's KYC compliance posture.

   - **What ZettaPay collects from you (the merchant)** (bulleted list — verify exact `RegisterMerchantInput` shape against `packages/sdk/src/types.ts` BEFORE writing; mirror the actual fields, not this spec):
     - Merchant handle (display name).
     - Solana pubkey (destination address for payments).
     - Webhook URL (TLS-only per Premissa 15).
     - Optional: BTC and ETH destination pubkeys for multi-chain (per the wallet-less HARD-rule + multi-chain pubkey derivation in `packages/sdk/src/derive.ts`).
     - NO tax ID. NO bank account. NO photo ID. NO incorporation documents.
     - There is no KYC pipeline on the merchant side either — pubkey + handle + webhook URL is the full registration surface.

   - **AML / Travel Rule** (1 paragraph): we do not custody, so the FATF Travel Rule (>$1k VASP-to-VASP transfer reporting) does not apply to us as a counterparty. It DOES apply to MoonPay on the fiat ramp side, where they collect the required Travel-Rule information from the customer.

   - **Smart contract audits + bug bounty** (1 paragraph): cross-link to `audit/BUG_BOUNTY.md` (`/audit/BUG_BOUNTY.md` if mintlify serves it; otherwise the GitHub URL) and `audit/SCOPE.md`. Premissa 18 (Smart contracts auditados por OtterSec ou Halborn antes mainnet — Z21) + Premissa 19 (Bug bounty $50k público pre-mainnet) are the security-posture half of the compliance story.

4. Do NOT modify `docs/docs.json` — sidebar registration is deferred to a separate trivial mission.
5. Do NOT touch any other file. No README updates, no `onramp.mdx` rewrites, no audit-doc edits.

Validation:
- `npm run docs:check` reports no broken links FROM this page. (Cross-links to `audit/*.md` resolve if mintlify serves the audit directory; if not, document the workaround in the PR description.)
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/concepts/compliance` if launched locally.
- `npm run build` unaffected.
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric. NO forbidden Veridian brand words ("revolution"/"disruption"/"synergy"/"game-changer"). The "Not an MSB" section MUST include the legal hedge "Regulatory posture differs by jurisdiction and evolves quickly. Check with your own counsel..." — do NOT make absolute regulatory claims.

Branch: `auto/<uuid>-concepts-compliance`. Open PR titled `docs(concepts): compliance — KYC via MoonPay, not an MSB`.$$,
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
     'mission_uuid_prefix', 'c3f319e1',
     'generated_at', '2026-05-17',
     'companion_doc', 'docs/discovery/c3f319e1-backlog-refill.md',
     'companion_sql', 'docs/discovery/c3f319e1-backlog-refill.sql',
     'mission_names', jsonb_build_array(
       'test(sdk): index.ts public re-export surface stability',
       'docs(concepts): idempotency-keys merchant concept page',
       'docs(guides): poll-payment-completion fallback guide',
       'test(embed): index.ts public re-export surface stability',
       'docs(concepts): compliance — KYC via MoonPay, not MSB'
     ),
     'themes', jsonb_build_array(
       'sdk/test/index.test.ts (TS SDK public re-export surface stability — ~95 named exports across 9 internal modules; widget version queued in 843972bd, embed companion is Pick #4 this pass)',
       'docs/concepts/idempotency-keys.mdx (merchant-facing concept doc for Premissa 10 — docs/api-reference/idempotency.mdx is technical ref; the WHY-to-set-the-header layer is missing)',
       'docs/guides/poll-payment-completion.mdx (canonical guide for poll-as-fallback / poll-as-primary integration pattern — webhook path has 4 docs, poll path has zero)',
       'embed/test/index.test.ts (public re-export + auto-init no-op contract — 843972bd explicitly deferred this until widget pattern proves out)',
       'docs/concepts/compliance.mdx (Premissa 17 — KYC via MoonPay, not MSB — load-bearing posture lives only in CLAUDE.md, invisible to merchants evaluating ZettaPay)'
     ),
     'avoided_repeat_rejections', jsonb_build_array(
       'packages/sdk/examples/quickstart.ts (@solana/web3.js bundling decision — rejected in #258, #259, #263)',
       'CHANGELOG.md (release-ops decision)',
       'per-SDK CHANGELOG.md',
       'CODEOWNERS (owner/team decision)',
       'FUNDING.yml (sponsor target bikeshed)',
       'CODE_OF_CONDUCT.md (enforcement contact decision)',
       'public/manifest.json PWA shell (needs coordinated service worker)',
       'public/favicon.* (needs brand design decision)',
       'aggressive CSP / HSTS / X-Frame-Options (page-by-page audit needed)',
       'packages/widget/test/{modal,styles}.test.ts (DOM-coupled, jsdom scaffolding required)',
       'packages/embed/test/ui.test.ts (jsdom-coupled, separate later mission)'
     ),
     'deferred_blocked_on_dependency', jsonb_build_array(
       'packages/sdk-php/tests/WebhookVerifierTest.php (source verifier queued in 1986ee3d but NOT yet shipped — find packages/sdk-php -name Webhook* returns empty; testing nonexistent source is blocked-on-dependency)',
       'packages/sdk-go/examples/poll.go (sdk-go examples/ directory does not exist yet; sdk-go quickstart is queued in 9db4cb78 but not shipped — example follows source)',
       'packages/sdk-python/examples/poll.py (sdk-python webhook example queued in c08a7f17 should ship first to establish the dual-example pattern)',
       'packages/sdk-rust/examples/poll.rs (same dependency on the queued webhook example)'
     ),
     'deferred_until_companion_pick_ships', jsonb_build_array(
       'docs.json sidebar registrations for /concepts/idempotency-keys, /guides/poll-payment-completion, /concepts/compliance (trivial 1-line array inserts; deferred to keep THIS pass strictly single-file per mission)',
       'docs/concepts/rate-limits.mdx (natural companion to idempotency-keys but bundling two concept docs in one refill risks crowding the sidebar mission)',
       'docs/concepts/multi-chain.mdx (would document the BTC/ETH/USDC pubkey-derivation HARD-rule; defer to next pass to keep concept-doc count at 2 this pass)',
       'docs/concepts/security.mdx (would cross-link to audit/ markdown files; separate mission to avoid duplicating audit/ contents)',
       'vitest.workspace.ts root aggregator (bigger lift than single-objective — requires per-package vitest.config.ts coordination + root package.json test script update)'
     ),
     'prior_refill_chain', jsonb_build_array(
       '#263 (843972bd)', '#262 (c08a7f17)', '#261 (07b1ae9c)', '#260 (03cf9a17)',
       '#259 (e365137f)', '#258 (66b549af)', '#257 (d5806497)', '#254 (bf6837e4)',
       '#253 (9db4cb78)', '#252 (a82d92db)', '#251 (1986ee3d)', '#245 (2e05f052)',
       '#244 (4f79ec06)', '#242 (69cdcbce)', '#231 (fba46358)'
     )
   ));
