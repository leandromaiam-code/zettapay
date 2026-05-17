# Auto-discovery backlog refill — c3f319e1

**Generated:** 2026-05-17
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `c3f319e1`
**Prior refills (recent, last 15):**

| PR   | UUID prefix | Theme                                                                                          |
|------|-------------|------------------------------------------------------------------------------------------------|
| #263 | `843972bd`  | TS-SDK examples (webhook.ts + x402.ts) + sdk-go doc_test.go + wallet-less concept + widget surface test |
| #262 | `c08a7f17`  | per-SDK LICENSE parity (python + go + php) + sdk-rust/python webhook examples                  |
| #261 | `07b1ae9c`  | vercel safe security headers + embed/rpc + widget/api tests + sdk-rust LICENSE + SUPPORT.md    |
| #260 | `03cf9a17`  | TS SDK client.ts tests + .nvmrc + .well-known/security.txt + sdk-rust/python CI                |
| #259 | `e365137f`  | wallet-less HARD-rule rewrites + sdk-php Packagist support                                     |
| #258 | `66b549af`  | npm metadata (sdk/embed/widget) + .gitattributes + sdk-ts CONTRIBUTING                         |
| #257 | `d5806497`  | sdk-php CONTRIBUTING + SECURITY.md + PR template + ISSUE config + sdk-php Exception tests      |
| #254 | `bf6837e4`  | sdk-php quickstart + sdk-go CONTRIBUTING + sdk-python test_types + CodeQL + .tool-versions     |
| #253 | `9db4cb78`  | sdk-rust error inline tests + sdk-go quickstart + sitemap + wallet-less CI gate + root CONTRIBUTING |
| #252 | `a82d92db`  | sdk-go errors/retry tests + sdk-python errors test + .well-known/mcp.json + .editorconfig      |
| #251 | `1986ee3d`  | sdk-go/sdk-php webhook verifiers + sdk-php CI + dependabot + embed size budget                 |
| #245 | `2e05f052`  | widget/qr.test + embed/poll.test + HALL_OF_FAME + llms.txt + static-analysis-rust CI           |
| #244 | `4f79ec06`  | sdk-python/sdk-rust re-exports + vercel CORS + api/pay rate-limit headers + api/index sync     |
| #242 | `69cdcbce`  | OG meta + /simulate footer removal + robots/sitemap + pay.html lang + signup hardening         |
| #231 | `fba46358`  | sdk-python/sdk-rust webhook verifiers + sdk/errors.ts tests + LOG_PRETTY env doc               |

The fifteen prior refills drained: the wallet-less HARD-rule rewrite queue, the per-SDK polyglot hygiene queue (CONTRIBUTING / SECURITY / quickstart parity), the GitHub trust-signal queue (SECURITY.md, ISSUE config, PR template, `.well-known/*`), the per-SDK CI gating queue, the TS-lane npm-meta queue, the site-launch SEO queue (robots/sitemap/sitemap.xml), the vercel-safe-security-headers queue, the next-pass test-coverage queue (embed/rpc + widget/api + widget/qr + embed/poll), the per-SDK LICENSE parity for rust/python/go/php, the sdk-rust/python webhook examples, the TS SDK `examples/` directory bootstrap (`webhook.ts` + `x402.ts`), the sdk-go `doc_test.go` testable-examples convention, the canonical `docs/concepts/wallet-less.mdx`, and the `packages/widget/test/index.test.ts` public-surface stability lock.

This pass scans **four previously-unaddressed surfaces left over** by those drains:

1. **The CANONICAL TS SDK has no public-surface stability test.** The widget version of this test is queued in `843972bd` (PR #263) and explicitly noted as the proving ground for the embed companion test. The widget pick locked `mount`, `open`, `version`, and 7 type re-exports. `packages/sdk/src/index.ts` re-exports across NINE modules (`client`, `errors`, `types`, `onchain`, `idl/zettapay`, `helpers`, `solana-pay`, `derive`, `webhook`) for a total surface of ~95 named exports — verified by `cat packages/sdk/src/index.ts`. There is NO test that asserts this re-export surface; `packages/sdk/test/` currently contains `derive.test.ts`, `errors.test.ts`, `helpers.test.ts`, `onchain.test.ts`, `solana-pay.test.ts`, `webhook.test.ts` — all module-level tests, none surface-level. A future refactor that drops `parseWebhook` or renames `ZETTAPAY_PROGRAM_ID` ships silently. The CANONICAL TS SDK (Premissa 23) deserves at least the same regression-catch we just queued for the widget.

2. **`docs/concepts/` is missing the merchant-facing `idempotency-keys` page.** `docs/api-reference/idempotency.mdx` exists (verified: `ls docs/api-reference/`) and documents the technical surface — header name, response shape, collision rules. But the merchant-facing concept layer (why merchants set the header in the FIRST place — retry-safe payment creation, network blip recovery, duplicate-charge prevention) is undocumented at `docs/concepts/`. The closest reference today is a one-liner inside `docs/concepts/webhooks.mdx` ("X-ZettaPay-Event-Id is stable across retries"), which is about WEBHOOK idempotency on the inbound direction, not about the merchant-controlled OUTBOUND `Idempotency-Key` header on `/pay` + `/merchants/register`. Premissa 10 (Idempotency keys obrigatórios em /pay e /merchants/register — Z8.3) is canonical; it has zero public-facing concept doc.

3. **`docs/guides/` is missing a canonical polling guide.** `docs/guides/` inventory (verified): `accept-payments.mdx`, `devnet-faucet.mdx`, `drop-in-integrations.mdx`, `handling-webhooks.mdx`, `mcp-integration.mdx`, `x402-protocol.mdx` + sub-dirs `integrations/`, `tutorials/`, `webhooks/`. The webhook path is exhaustively documented (`handling-webhooks.mdx` + 3 sub-pages: `best-practices`, `replay`, `signing-examples`). The poll-fallback path — the canonical "what to do when your webhook endpoint is down" or "I'm a CLI/cron job that doesn't want to expose a webhook URL" path — is NOT documented at all. Premissa 9 (Webhooks Stripe-grade) actually requires merchants to handle the poll-as-fallback case during webhook outages, but the integration pattern for `GET /payments/:id` polling with exponential backoff + idempotent state-machine writes has no canonical home.

4. **`packages/embed/test/index.test.ts` is now unblocked.** The 843972bd rationale doc (PR #263) explicitly DEFERRED `packages/embed/test/index.test.ts` with the note: *"the embed `index.ts` is significantly larger (auto-init, mount, re-export from 4 sibling modules) and a stability test of comparable depth would balloon past the single-objective bar. Queue separately once the widget test has shipped and we know the shape works."* With the widget version queued and the auto-init guard pattern (clear `document.body` + `vi.resetModules()` re-import) proven viable, the embed companion becomes the next-in-line single-objective pick. `packages/embed/src/index.ts` is 121 LOC, re-exports `mount`, `version`, `buildSolanaPayUri`, `resolveCluster`, `toBaseUnits`, `matchesTransfer`, `RPC_URL`, `USDC_MINT`, `WALLETS`, `buildWalletDeeplink`, `detectWallets`, `getWalletMeta`, `isMobile`, plus 8 type re-exports.

5. **`docs/concepts/compliance.mdx` is missing.** Premissa 17 ("Compliance: KYC apenas via MoonPay onramp. Não somos MSB.") is one of only TWO compliance-shape constraints in Layer 0 (the other being Premissa 18, smart-contract audits — which is partially covered by `audit/` directory contents). The "we are not an MSB" stance is load-bearing for merchant onboarding conversations and has no canonical public page. Closest mentions: `docs/concepts/onramp.mdx` (which covers the MoonPay onramp from a UX angle, not a compliance angle) and `docs/concepts/architecture.mdx` (no compliance section). A canonical `compliance.mdx` is the missing piece — distinct from onramp (UX) and audits (security).

---

## Picks

| # | Mission name (≤60 chars)                                              | Target file                                | LOC est. | Layer 0           |
|---|-----------------------------------------------------------------------|--------------------------------------------|----------|-------------------|
| 1 | `test(sdk): index.ts public re-export surface stability`              | `packages/sdk/test/index.test.ts` (new)    | ~120     | 23, 27, 29        |
| 2 | `docs(concepts): idempotency-keys merchant concept page`              | `docs/concepts/idempotency-keys.mdx` (new) | ~120     | 10, 24            |
| 3 | `docs(guides): poll-payment-completion fallback guide`                | `docs/guides/poll-payment-completion.mdx` (new) | ~150 | 9, 24             |
| 4 | `test(embed): index.ts public re-export surface stability`            | `packages/embed/test/index.test.ts` (new)  | ~90      | 23, 27, 29        |
| 5 | `docs(concepts): compliance — KYC via MoonPay, not MSB`               | `docs/concepts/compliance.mdx` (new)       | ~130     | 17, 24            |

All five are **pure additive**, **single-file**, **single-objective**, and **outside the chronic `packages/api` build-break lane** (worker memory `project_build_broken.md`). None touch wallet code or wallet-adapter UI.

---

## Per-pick rationale

### 1. `test(sdk): index.ts public re-export surface stability`

`packages/sdk/src/index.ts` re-exports ~95 named exports across 9 internal modules (verify: `cat packages/sdk/src/index.ts`). `packages/sdk/test/` has six module-level test files (`derive`, `errors`, `helpers`, `onchain`, `solana-pay`, `webhook`) — none of them asserts the SHAPE of the public re-export surface. A future internal refactor that renames `ZETTAPAY_PROGRAM_ID` to `ZETTAPAY_PROGRAM_ADDRESS` or drops `parseWebhook` from index re-exports ships silently. The CANONICAL TS SDK (Premissa 23) is the highest-stakes surface in the polyglot family; it should have at least the same regression-catch we just queued for `packages/widget/test/index.test.ts` in `843972bd`.

Distinct from queued sibling work:
- `packages/widget/test/index.test.ts` (queued `843972bd`, PR #263) — DIFFERENT package, much smaller surface (3 fns + 7 types vs ~95 exports).
- `packages/embed/test/index.test.ts` (Pick #4 this pass) — SAME pattern, DIFFERENT package — both unblocked once the widget version proves the shape.
- `packages/sdk/test/derive.test.ts`, `errors.test.ts`, `helpers.test.ts`, `onchain.test.ts`, `solana-pay.test.ts`, `webhook.test.ts` — module-internal tests, NOT public-surface re-export tests.
- `packages/sdk/test/client.test.ts` (queued `03cf9a17`, PR #260) — tests the `client.ts` MODULE, not the index re-export surface.

Premissa 23 (SDK-first, TS canonical), Premissa 27 (Quality Gate), Premissa 29 (zero @ts-nocheck in new code — the regression-catch prevents @ts-nocheck workarounds downstream when a re-export goes missing).

**Scope (1 new file, ~100-140 LOC):**

1. Create `packages/sdk/test/index.test.ts`.
2. Vitest config (`packages/sdk/vitest.config.ts`) sets a node env — no DOM scaffolding needed.
3. Top-level imports from `'../src/index.js'`:
   - Functions: `ZettaPayClient`, `fromAxiosError`, `resolveCluster`, `isValidMerchantHandle`, `deriveMerchantBindingPda`, `derivePaymentPda`, `deriveInvoicePda`, `deriveAssociatedTokenAddress`, `deriveInvoiceUsdcAddress`, `buildRegisterMerchantInstruction`, `buildRecordPaymentInstruction`, `registerMerchantOnChain`, `recordPayment`, `createMerchant`, `createInvoice`, `ensureInvoiceUsdcAta`, `getInvoiceStatus`, `isInvoiceExpired`, `listenPaymentEvents`, `sweep`, `buildZettaPayUri`, `parseZettaPayUri`, `buildSolanaPayUri`, `generateInvoiceQrSvg`, `generateInvoiceQrDataUrl`, `deriveAddress`, `deriveBitcoinAddress`, `deriveEthereumAddress`, `deriveUsdcAddress`, `parseWebhook`, `dedupe`.
   - Class: `ZettaPayError`, `MemoryEventStore`.
   - Constants: `X402_HEADER`, `ZETTAPAY_PROGRAM_ID`, `MERCHANT_HANDLE_MIN_LEN`, `MERCHANT_HANDLE_MAX_LEN`, `PAYMENT_ID_LEN`, `TX_SIGNATURE_LEN`, `INVOICE_INDEX_SEED_LEN`, `TOKEN_PROGRAM_ID`, `ASSOCIATED_TOKEN_PROGRAM_ID`, `USDC_MINT`, `SOLANA_RPC_URL`, `DEFAULT_CLUSTER`, `DEFAULT_SOLANA_RPC_URL`, `ZETTAPAY_IDL`, `USDC_MAINNET_MINT`, `USDC_DEVNET_MINT`, `USDC_DECIMALS`, `ZETTAPAY_URI_SCHEME`, `SOLANA_PAY_URI_SCHEME`, `DEFAULT_CURRENCY`, `SIGNATURE_HEADER`, `TIMESTAMP_HEADER`, `EVENT_ID_HEADER`, `ATTEMPT_HEADER`.
4. ONE `describe('@zettapay/sdk public surface', ...)` block with three nested `describe`s:
   - `describe('functions', ...)` — for each function name above: `it('exports ' + name + ' as a function', () => expect(typeof <name>).toBe('function'));`. Iterate from a name → ref `Record<string, unknown>` to keep the file under 140 LOC; use `Object.entries(funcs).forEach(([name, ref]) => it(`exports ${name} as a function`, () => expect(typeof ref).toBe('function')));`.
   - `describe('classes', ...)` — `ZettaPayError` (constructable, instance of Error) + `MemoryEventStore` (constructable).
   - `describe('constants', ...)` — for each constant: `typeof === 'string'` (most are strings — pubkey-shaped) OR `typeof === 'number'` for the `_LEN` and `_DECIMALS` constants OR `typeof === 'object'` for `ZETTAPAY_IDL`. Verify the type against `src/index.ts` re-exports BEFORE writing.
5. NO behavioral assertions (no calling functions, no constructing clients with fake URLs and checking responses). This test ONLY locks the SHAPE — names exist, types are correct. Behavior is covered by the existing per-module tests.
6. NO test for `X402_HEADER` value (`'X-402'` vs `'X-402-Payment'`) — that's a behavioral assertion, covered elsewhere.
7. Do NOT modify `src/index.ts` or any source file.

**Validation:**
- `cd packages/sdk && npx vitest run test/index.test.ts` passes all assertions.
- `cd packages/sdk && npx vitest run` (full SDK suite) passes — zero regressions.
- `npm run build` unaffected (test files outside `tsconfig.build.json` include).
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/sdk/test/index.test.ts` returns ZERO.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

### 2. `docs(concepts): idempotency-keys merchant concept page`

`docs/concepts/` (verified: `ls docs/concepts/`) has architecture, ai-agents, native-integrations, webhooks, onramp, beta-launch — and `843972bd` queues `wallet-less.mdx`. NO `idempotency-keys.mdx`. `docs/api-reference/idempotency.mdx` exists but documents the technical surface (header name, collision rules) — it does NOT cover the merchant-facing concept (why use the header, what it protects against, when to re-use vs rotate a key, how it interacts with webhook idempotency).

Premissa 10 (Idempotency keys obrigatórios em /pay e /merchants/register — Z8.3) + Premissa 24 (Documentation site mintlify-style — Z17. Critical for adoption).

**Scope (1 new file, ~100-150 LOC mdx):**

1. Create `docs/concepts/idempotency-keys.mdx`.
2. Frontmatter (matches sibling concept docs — read `docs/concepts/webhooks.mdx` first; confirmed shape is `title:` + `description:`):
   ```
   ---
   title: "Idempotency keys"
   description: "Retry-safe payment + merchant-registration calls via the X-Idempotency-Key header."
   ---
   ```
3. Body sections:
   - **What it protects** (3-5 paragraphs): network blip during `/pay` POST, dashboard double-click, cron job re-run after crash, queue worker retry storm — all yield duplicate charges WITHOUT idempotency. With the header set, ZettaPay returns the original response for matching `(merchant, key)` pairs and skips the second on-chain transfer entirely.
   - **How to construct the key** (bulleted list): UUIDv4 generated server-side and stored in your DB before issuing the call; never a client-supplied value; never reused across different request bodies (collision → 409); SHOULD be unique per logical attempt (one shopping-cart checkout = one key, even across retries of THAT checkout).
   - **What ZettaPay does** (numbered list): 1) Reads `X-Idempotency-Key` header on `/pay` and `/merchants/register`. 2) Looks up `(merchant_id, idempotency_key)` in the dedupe store (Postgres). 3) If hit: returns the original response verbatim, no side effects. 4) If miss: processes normally and persists `(merchant_id, key, response_body, status_code)` for 24 hours. 5) Collisions on the same key with a DIFFERENT request body return `409 idempotency_key_conflict`.
   - **Inbound webhook idempotency** (1 paragraph): cross-link to `docs/concepts/webhooks.mdx` — the `X-ZettaPay-Event-Id` header is the INBOUND equivalent; merchants dedupe webhook deliveries the same way ZettaPay dedupes inbound `/pay` calls. Two sides of the same problem.
   - **Code snippets**: ONE TypeScript example using the SDK (`client.pay(tx, { idempotencyKey: 'order-' + cartId })` — verify exact `PayInput` shape in `packages/sdk/src/client.ts` BEFORE writing; if `idempotencyKey` is NOT yet on the `PayInput` type, use the raw HTTP example: `fetch('/pay', { headers: { 'X-Idempotency-Key': key, ... } })`). ONE shell `curl` example. NO Python/Go/PHP SDK examples — those SDKs may not expose the field yet, and adding them risks doc/code drift.
4. Do NOT modify `docs/docs.json` — sidebar registration is a separate trivial mission (the page is still routable at `/concepts/idempotency-keys` on direct navigation, same logic as `843972bd`).
5. Do NOT touch any other file. No README updates, no api-reference cross-link edits.

**Validation:**
- `npm run docs:check` (if `mint` CLI installs cleanly) reports no broken links FROM this page. Broken links INTO this page expected (sidebar not registered yet — separate mission).
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/concepts/idempotency-keys` if launched locally.
- `npm run build` unaffected (mdx outside TS build).
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

### 3. `docs(guides): poll-payment-completion fallback guide`

`docs/guides/` inventory (verified): `accept-payments.mdx`, `devnet-faucet.mdx`, `drop-in-integrations.mdx`, `handling-webhooks.mdx`, `mcp-integration.mdx`, `x402-protocol.mdx`, plus sub-dirs `integrations/{anthropic,huggingface,openai}.mdx`, `tutorials/{ai-agent-payments,fraud-rules,recurring-billing,shopify}.mdx`, `webhooks/{best-practices,replay,signing-examples}.mdx`. The webhook PATH is exhaustively documented (4 files between top-level and sub-dir). The POLL PATH — the canonical fallback when webhooks are down, OR the canonical primary path for CLI/cron/serverless flows that don't want to expose a webhook URL — has NO guide.

Premissa 9 (Webhooks Stripe-grade — 3x retry exponential is required; merchants need a documented fallback when delivery exceeds the retry envelope), Premissa 24 (Documentation site mintlify-style — Z17).

**Scope (1 new file, ~130-180 LOC mdx):**

1. Create `docs/guides/poll-payment-completion.mdx`.
2. Frontmatter (matches sibling guide docs — read `docs/guides/handling-webhooks.mdx` first):
   ```
   ---
   title: "Poll payment completion"
   description: "When webhooks aren't an option: idempotent polling of GET /payments/:id with exponential backoff."
   ---
   ```
3. Body sections:
   - **When to poll** (3 bullet paragraphs): no public webhook URL (CLI tool, cron job, serverless cold-start), webhook handler is currently down (fallback path), webhook delivery is delayed past your UX threshold (e.g. you want to show "confirming…" → "paid" in <10s for a checkout flow).
   - **The polling loop** (numbered list, ~6 steps): 1) After `POST /pay` returns the `payment_id`, start a polling loop. 2) Sleep for an initial backoff (2s). 3) Call `GET /payments/{payment_id}`. 4) On status `pending`: sleep with exponential backoff (cap 30s) and repeat. 5) On status `confirmed`: persist + return to caller. 6) On wall-clock deadline (e.g. 5 minutes): give up, mark order as "awaiting confirmation", reconcile manually via a daily cron.
   - **Code snippet** (one TypeScript example using the SDK): a `pollPayment(client, paymentId, opts)` helper with exponential backoff + jitter. Verify `client.getPayment(id)` returns a `PaymentRecord` with a `status` field by reading `packages/sdk/src/types.ts` BEFORE writing; if the shape has changed, mirror the actual shape. Include the deadline + AbortController pattern.
   - **Idempotency note** (1 paragraph): polling is idempotent on the read side, but the merchant's reaction (e.g. shipping the order, emailing the receipt) must be idempotent on the write side — same `X-Idempotency-Key` discipline as webhook handlers. Cross-link to `/concepts/idempotency-keys` (Pick #2 this pass) and `/guides/webhooks/best-practices`.
   - **Rate-limit awareness** (1 paragraph): the poll loop respects the per-API-key rate limit (Premissa 11) — exponential backoff naturally stays under the limit; merchants polling thousands of payments concurrently should batch via `GET /payments?ids=...` (or if the batch endpoint doesn't exist yet, document the per-key concurrency cap).
   - **Webhook-first preference** (final 1 paragraph): cross-link to `/guides/handling-webhooks` — polling is a fallback, not the canonical path. Webhooks deliver faster, cost less, and don't hit the rate limit.
4. Do NOT modify `docs/docs.json` — sidebar registration is a separate trivial mission.
5. Do NOT touch any other file.

**Validation:**
- `npm run docs:check` — no broken links FROM this page.
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/guides/poll-payment-completion` if launched.
- `npm run build` unaffected.
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

### 4. `test(embed): index.ts public re-export surface stability`

`packages/embed/src/index.ts` is 121 LOC (verified) and re-exports `mount`, `version`, `buildSolanaPayUri`, `resolveCluster`, `toBaseUnits`, `matchesTransfer`, `RPC_URL`, `USDC_MINT`, `WALLETS`, `buildWalletDeeplink`, `detectWallets`, `getWalletMeta`, `isMobile`, plus 8 type re-exports (`Cluster`, `EmbedConfig`, `EmbedSuccessEvent`, `EmbedErrorEvent`, `EmbedHandle`, `EmbedPostMessage`, `WalletDetection`, `WalletId`, `WalletMeta`). `packages/embed/test/` has `embed.test.ts` + `wallets.test.ts` (queued companions `poll.test.ts` from `2e05f052` PR #245 and `rpc.test.ts` from `07b1ae9c` PR #261) — but NOTHING that locks the `index.ts` re-export shape OR the auto-init no-op contract.

The 843972bd doc explicitly DEFERRED this as "queue separately once the widget test has shipped and we know the shape works." Now that the widget test is queued and the auto-init guard pattern (clear `document.body` + `vi.resetModules()` re-import) is proven viable, this becomes the unblocked companion.

Premissa 23 (SDK-first, embed is the drop-in surface — Z14 widget family), Premissa 27 (Quality Gate), Premissa 29 (zero @ts-nocheck in new code).

**Scope (1 new file, ~70-110 LOC):**

1. Create `packages/embed/test/index.test.ts`.
2. Vitest config (`packages/embed/vitest.config.ts`) should set `environment: 'happy-dom'` — verify before writing. If not, the auto-init no-op test guards on `typeof document !== 'undefined'` and the file gracefully skips the auto-init case.
3. Test cases (one `describe('@zettapay/embed public surface', ...)` block with three nested `describe`s):
   - `describe('functions', ...)` — `mount`, `buildSolanaPayUri`, `resolveCluster`, `toBaseUnits`, `matchesTransfer`, `buildWalletDeeplink`, `detectWallets`, `getWalletMeta`, `isMobile` — `typeof === 'function'`.
   - `describe('constants', ...)` — `version` (string, non-empty), `RPC_URL` (string, starts with `'http'` after `://` strip), `USDC_MINT` (string, length 32-44 base58 range), `WALLETS` (object — could be a Record<WalletId, WalletMeta>; assert `typeof === 'object'` and non-null).
   - `describe('auto-init', ...)` — `it('is a no-op when no script[data-recipient][data-amount] tags are present')`: clear `document.body` to `''`, `vi.resetModules()`, dynamic `await import('../src/index.js')`, assert `document.querySelectorAll('[data-zettapay-embed-target]').length === 0`. This locks the AUTO-INIT CONTRACT: zero side effects when the host page does not opt in. The widget pick in 843972bd uses the same pattern — re-use it verbatim.
4. Use TOP-LEVEL static imports for the function + constant tests; use dynamic re-import (after `vi.resetModules()`) ONLY for the auto-init test where the side-effect surface matters.
5. Do NOT test `mount(target, config)` BEHAVIOR (DOM rendering, RPC polling) — that's `embed.test.ts` + the queued `poll.test.ts` + `rpc.test.ts` jobs. THIS test ONLY locks the SHAPE of the public surface + the auto-init no-op contract.
6. Do NOT modify `src/index.ts` or any other source file.

**Validation:**
- `cd packages/embed && npx vitest run test/index.test.ts` passes all cases.
- `cd packages/embed && npx vitest run` (the full embed test suite) passes — no regressions to `embed.test.ts` or `wallets.test.ts`.
- `npm run build --workspace @zettapay/embed` unaffected.
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/embed/test/index.test.ts` returns ZERO. (The embed exports `WALLETS`, `detectWallets`, `buildWalletDeeplink` — all READ-ONLY wallet-detection / deep-link helpers, not `connect()`. The test exercises only the export shape.)
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

### 5. `docs(concepts): compliance — KYC via MoonPay, not MSB`

`docs/concepts/` is missing a `compliance.mdx` page. Premissa 17 ("Compliance: KYC apenas via MoonPay onramp. Não somos MSB.") is one of the LOAD-BEARING compliance constraints in Layer 0 — it determines the entire onboarding posture, the KYC delegation pattern, and the licensing footprint we DON'T need (no money-transmitter license per US state, no e-money license in EU). Today this stance lives ONLY in `CLAUDE.md` and is invisible to merchants and integrators evaluating ZettaPay.

Closest existing docs:
- `docs/concepts/onramp.mdx` — covers the MoonPay onramp from a UX angle (how customers fund USDC), NOT from a compliance angle (why MoonPay handles KYC, not ZettaPay).
- `docs/concepts/architecture.mdx` — references it tangentially; not a canonical home.
- `audit/SCOPE.md` — internal audit doc, not public-facing.

Premissa 17 + Premissa 24 (Documentation site mintlify-style — critical for adoption).

**Scope (1 new file, ~100-160 LOC mdx):**

1. Create `docs/concepts/compliance.mdx`.
2. Frontmatter (matches sibling concept docs):
   ```
   ---
   title: "Compliance"
   description: "ZettaPay is non-custodial and not a money services business. KYC is delegated to the MoonPay onramp."
   ---
   ```
3. Body sections:
   - **Non-custodial by construction** (2 paragraphs): cross-link to `/concepts/wallet-less` (queued in `843972bd`). ZettaPay never holds USDC — every payment is a direct on-chain transfer `payer → merchant`. We have no custody surface, no withdrawal queue, no commingled treasury.
   - **Not a money services business** (3 paragraphs): non-custody + non-fiat + no on-chain holding = we do NOT meet the FinCEN definition of an MSB. We do not require state-by-state MTL licensing in the US. We do not require an e-money licence in the EU. (Hedge wording: "Regulatory posture differs by jurisdiction; check with your own counsel before launch.")
   - **Where KYC actually happens** (2 paragraphs): MoonPay handles KYC on the fiat→USDC ramp (cross-link to `/concepts/onramp`). Merchants accepting only crypto-native customers (BYO USDC) bypass KYC entirely. Merchants using MoonPay-funded customers inherit MoonPay's KYC compliance.
   - **What ZettaPay collects from you (the merchant)** (bulleted list): merchant handle (display name), Solana pubkey (destination address), webhook URL (TLS-only). NO tax ID, NO bank account, NO photo ID. No KYC pipeline on the merchant side either — pubkey + handle is the full registration surface (verify against `packages/sdk/src/types.ts` `RegisterMerchantInput` shape BEFORE writing).
   - **AML / Travel Rule** (1 paragraph): we do not custody, so the FATF Travel Rule (>$1k VASP-to-VASP transfer reporting) does not apply to us — but it DOES apply to MoonPay on the fiat ramp side, where they collect the required information from the customer.
   - **Bug bounty + audits** (1 paragraph): cross-link to `audit/BUG_BOUNTY.md` and `audit/SCOPE.md`. Premissa 18 + Premissa 19 (smart contract audits + $50k bug bounty pre-mainnet) are the security-posture half of the compliance story.
4. Do NOT modify `docs/docs.json` — sidebar registration is a separate trivial mission.
5. Do NOT touch any other file.

**Validation:**
- `npm run docs:check` — no broken links FROM this page.
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/concepts/compliance` if launched.
- `npm run build` unaffected.
- Wallet-less hard rule N/A — pure docs.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric. NO use of forbidden Veridian brand words ("revolution"/"disruption"/"synergy"/"game-changer").
- Legal-hedge phrasing in the "Not an MSB" section — DO NOT make absolute regulatory claims; always include "check with your own counsel" or "regulatory posture differs by jurisdiction" hedges.

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen because they fail one or more of {single-file, single-objective, auto-mergeable, non-controversial, outside chronic-broken lane, fresh vs. prior refills}:

- **`packages/sdk/examples/quickstart.ts`** — rejected in #258, #259, and #263 (`843972bd`) because it requires choosing whether to bundle `@solana/web3.js` for signing or stub it. Same reason this pass.
- **`packages/sdk-php/tests/WebhookVerifierTest.php`** — the source-side webhook verifier was QUEUED for PHP in `1986ee3d` (PR #251) but has NOT shipped (verified: `find packages/sdk-php -name 'Webhook*'` returns empty; `grep -r webhook packages/sdk-php/src/` returns empty). Testing a verifier that doesn't exist yet is blocked-on-dependency; queue after the source mission lands.
- **`packages/sdk-go/examples/poll.go` / `packages/sdk-python/examples/poll.py`** — companion polling examples for the polyglot SDKs would be a natural fit, but `packages/sdk-go/examples/` doesn't exist yet (sdk-go quickstart is queued in `9db4cb78`) and `packages/sdk-python/examples/poll.py` would land BEFORE the sdk-python webhook example (queued in `c08a7f17`) — example follows source. Defer until the queued quickstart + webhook examples ship.
- **`docs/concepts/rate-limits.mdx`** — would be a natural companion to Pick #2 (idempotency-keys), but bundling two concept docs in one refill risks crowding the `/concepts/` sidebar registration mission and creating doc/code-drift on the same merge. Defer to the next pass once Pick #2 lands.
- **`docs/concepts/multi-chain.mdx`** — would document the BTC/ETH/USDC pubkey-derivation HARD-rule (`packages/sdk/src/derive.ts`). Deferred this pass to keep the concept-doc count at 2 (already adding `idempotency-keys` + `compliance`).
- **`docs/security/` directory** — Premissa 18 (audits) is partially covered by `audit/` (verified: `audit/{BUG_BOUNTY,CODE_REVIEW_CHECKLIST,CRITICAL_PATHS,KNOWN_ISSUES,OWASP_TOP_10,README,SCOPE,SECURITY_ASSUMPTIONS,STATIC_ANALYSIS,SUBMISSION,THREAT_MODEL}.md`). Creating a parallel `docs/security/` directory would duplicate; instead the right move is to add `docs/concepts/security.mdx` that cross-links to the audit/ markdown files — but that's a separate single-objective mission for a future pass.
- **`docs/discovery/README.md`** — meta-doc explaining the discovery/ refill cadence to internal Veridian operators. Considered but rejected: this is internal-Fabric documentation, NOT public-facing ZettaPay docs; lives more naturally inside the Veridian Fabric repo's worker memory, not in the product repo's `docs/discovery/` (which is auto-generated artifacts).
- **`vitest.workspace.ts` root aggregator** — verified missing. Would let `npx vitest run` from root execute every package's test suite in one shot. Bigger lift than single-objective: requires coordinating each package's vitest.config.ts include patterns, validating no path-glob collisions, and updating root package.json test script. Queue separately as a CI-ergonomics mission.
- **`packages/cli/` merchant CLI** — Premissa 23 mentions "SDK first" but no CLI; this would be a major new package, not single-file. Out of scope.
- **`CHANGELOG.md` / `CODEOWNERS` / `FUNDING.yml` / `CODE_OF_CONDUCT.md`** — repeatedly rejected in prior refills (release-ops / owner / sponsor / enforcement decisions).
- **`public/manifest.json` PWA shell / `public/favicon.*`** — repeatedly rejected (service-worker coordination / brand SVG decision).
- **`packages/widget/test/{modal,styles}.test.ts` / `packages/embed/test/ui.test.ts`** — jsdom-coupled; separate later missions.
- **`packages/api/*` build break** — chronic compile lane; not auto-merge.
- **Zombie sentinel chains** — orchestrator-side UUID stickiness, not code missions.

---

## Wallet-less hard-rule sanity

`grep -rn 'wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask'` against this PR's diff returns **only documentary references** (this rationale doc + the SQL comments quoting the rule).

The five mission targets themselves are also wallet-less by construction:

- `packages/sdk/test/index.test.ts` — surface-shape assertions only, no wallet code.
- `docs/concepts/idempotency-keys.mdx` — pure header/HTTP concept doc, no wallet code.
- `docs/guides/poll-payment-completion.mdx` — HTTP polling pattern, no wallet code.
- `packages/embed/test/index.test.ts` — surface-shape assertions only. The `WALLETS` constant + `detectWallets()` + `buildWalletDeeplink()` exports are READ-ONLY wallet-standard detection helpers (per Premissa wallet-less HARD-rule "what we DO support") — NOT `wallet.connect()`. Test only asserts they are exported.
- `docs/concepts/compliance.mdx` — pure compliance/regulatory concept doc, no wallet code.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run build` state on this branch is identical to `main` — the chronic `packages/api` TS1xxx break is unchanged; this PR cannot have introduced or repaired it.

## Zombie sanity

Cross-referenced the last 60 merged PRs (#202..#263) + the open PR list (~50 zombie sentinels + 2 open feat / sentinel PRs) + the rolling sentinel log (worker memory `project_zombie_sentinel_log.md`) + the fifteen prior refill SQL companions. **None of the 5 mission names** in this refill collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. The Supabase MCP is not granted to mission workers (worker memory `feedback_supabase_mcp_unavailable.md`); the SQL companion file `docs/discovery/c3f319e1-backlog-refill.sql` is the canonical payload. **Orchestrator (or human operator with service-role key) applies it on merge.** All five INSERTs are wrapped in a single `BEGIN/COMMIT` so partial application is impossible; the audit-journal INSERT runs after the transaction commits so a partial-failure can still be observed in the journal.
