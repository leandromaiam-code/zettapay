-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 843972bd
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/843972bd-backlog-refill.md
--
-- All 5 picks are single-file, single-objective, additive, outside the
-- chronic-broken packages/api compile lane, wallet-less-compliant, and
-- distinct from prior refills (c08a7f17, 07b1ae9c, 03cf9a17, e365137f,
-- 66b549af, d5806497, bf6837e4, 9db4cb78, a82d92db, 1986ee3d, 2e05f052,
-- 4f79ec06, 69cdcbce, fba46358 — 14 prior passes scanned).
--
-- Themes covered this pass:
--   1. Canonical TS SDK examples directory bootstrap — the polyglot rust
--      and python SDKs both ship examples/ (webhook example queued in
--      c08a7f17, quickstart already on disk). The CANONICAL TS SDK
--      (Premissa 23) has NO examples/ at all. This pass adds the two
--      examples that don't require @solana/web3.js (the bundling-vs-stub
--      design call that prior refills #258 + #259 cited to defer
--      quickstart.ts): webhook.ts (pure node:crypto + parseWebhook) and
--      x402.ts (PayInput + X402_HEADER wiring with a placeholder signed
--      tx, same pattern as packages/sdk/test/* fixtures).
--   2. Go ecosystem-specific quality signal — pkg.go.dev renders
--      Example* functions inline under each function doc page and
--      `go test` compile-tests them. doc_test.go is the idiomatic Go
--      convention; orthogonal to quickstart.go (queued runnable binary,
--      9db4cb78) and CONTRIBUTING.md (queued, bf6837e4).
--   3. Public concept doc for the wallet-less HARD-rule — CLAUDE.md
--      documents the rule for mission workers; merchants + integrators
--      reading docs/concepts/ get architecture, ai-agents, webhooks,
--      onramp, beta-launch but NO wallet-less concept page. Single mdx
--      file (sidebar registration in docs.json deferred to a trivial
--      separate mission to keep this pass strictly single-file).
--   4. Widget public re-export surface stability test — the public
--      surface (mount, open, version, type re-exports) has no test;
--      regressions ship silently. happy-dom env already wired in
--      packages/widget/vitest.config.ts — no DOM scaffolding required.
--
-- Repeat-rejection themes AVOIDED in this refill (each rejected 2+
-- times by prior reviewers): CHANGELOG.md (release-ops decision),
-- per-SDK CHANGELOG.md, CODEOWNERS, FUNDING.yml, CODE_OF_CONDUCT.md,
-- public/manifest.json PWA shell, public/favicon.*, aggressive
-- CSP/HSTS/X-Frame-Options, packages/sdk/examples/quickstart.ts
-- (@solana/web3.js bundling decision — DELIBERATELY not picked,
-- replaced with examples/webhook.ts + examples/x402.ts which dodge
-- the dep dilemma entirely).
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are
-- the canonical payload the orchestrator (or a human operator with
-- the service-role key) should apply on merge. All inserts are
-- deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. TS SDK — examples/webhook.ts end-to-end demo (parity with queued sdk-rust + sdk-python webhook examples)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(sdk): examples/webhook.ts end-to-end demo',
$$Add `packages/sdk/examples/webhook.ts` — a runnable example demonstrating the sign → verify round-trip using the public webhook API in `packages/sdk/src/webhook.ts`. Today the CANONICAL TS SDK (Premissa 23: `@zettapay/sdk` in TypeScript canonical) has **no `examples/` directory at all** (verify: `ls packages/sdk/` shows `src test LICENSE README.md package.json tsconfig.json vitest.config.ts` — no `examples/`). The polyglot sdk-rust and sdk-python both ship `examples/quickstart.*` already and their webhook examples are queued in pass c08a7f17 (PR #262). This mission creates the TS examples directory with the FIRST file the webhook-signature verification flow that merchants need to wire up first when accepting payments.

Why this is fresh and not a repeat-rejection: `packages/sdk/examples/quickstart.ts` was rejected in #258 and #259 because it requires choosing whether to bundle `@solana/web3.js` (to sign a real tx for the demo) or stub it. The `webhook.ts` example has NO such dependency — `parseWebhook` uses only `node:crypto` internally and the example caller uses only `node:crypto` for sign-side HMAC. Zero dep dilemma.

Premissa 9 (Webhooks Stripe-grade — signature verification is the canonical reliability primitive), Premissa 23 (SDK-first DX, TS canonical), Premissa 25 (DevRel + open SDK > paid marketing).

Public surface to exercise (read from `packages/sdk/src/webhook.ts` + `packages/sdk/src/index.ts` before writing):
- `parseWebhook(opts)` — re-exported at the package root.
- `ParseWebhookOptions`, `ParseWebhookResult`, `ParsedWebhook`, `WebhookFailureReason`, `HeaderBag` types.
- `SIGNATURE_HEADER`, `TIMESTAMP_HEADER`, `EVENT_ID_HEADER`, `ATTEMPT_HEADER` constants.
- Existing tests in `packages/sdk/test/webhook.test.ts` show exact signature format (`sha256={hex}` over `${timestamp}.${body}`) and the headers shape — mirror that.

Scope (1 new file, ~90-120 LOC):

1. Create `packages/sdk/examples/webhook.ts`.
2. Header docstring (`/** ... */`) modeled on the queued sdk-rust webhook example: title `End-to-end ZettaPay TS SDK webhook verification`, a `## Run` section with `npx tsx examples/webhook.ts`, and a one-line scope statement.
3. Demonstrate three concrete cases in a top-level `async function main()`:
   - **Sign + verify round-trip** — generate timestamp = `Date.now()`, JSON body, compute HMAC-SHA256 over `${timestamp}.${body}` with `createHmac('sha256', secret).update(...).digest('hex')`, prefix `sha256=`, build the `headers` dict with `SIGNATURE_HEADER` / `TIMESTAMP_HEADER` / `EVENT_ID_HEADER`, call `parseWebhook({ secret, body, headers })`, assert the result is `{ ok: true, parsed }`. Print `✓ sign/verify round-trip ok`.
   - **Expired timestamp** — same payload + signature but timestamp 6 minutes (360_000 ms) in the past, assert result is `{ ok: false, reason: 'timestamp_out_of_tolerance' }`. Print `✓ expired timestamp rejected`.
   - **Bad signature** — tampered body (append a byte), assert `{ ok: false, reason: 'signature_mismatch' }`. Print `✓ tampered payload rejected`.
4. Import from the package root: `import { parseWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from '../src/index.js';` (relative path so the example is runnable directly with `tsx` from `packages/sdk/` without needing the package to be installed). Use only public re-exports — no `../src/webhook.js` deep imports.
5. Provide `main().catch((err) => { console.error(err); process.exit(1); });` at the bottom.
6. Do NOT modify `src/webhook.ts` — examples only.
7. Do NOT add new runtime or dev dependencies. Use only `node:crypto` (`createHmac`) from the Node stdlib.
8. Do NOT create `packages/sdk/examples/README.md`, `packages/sdk/examples/quickstart.ts`, or `packages/sdk/examples/x402.ts` — those are scope creep / separate missions. THIS mission ships ONE file.

Validation:
- `node --import tsx packages/sdk/examples/webhook.ts` (with tsx installed via the workspace) exits 0 and prints exactly three `✓` lines.
- `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict packages/sdk/examples/webhook.ts` typechecks clean against the TS SDK's existing tsconfig.
- `npm run build` unaffected — `packages/sdk/tsconfig.json` does not include `examples/` (verify before writing; if it does, that's a separate prior decision and the example must respect it).
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|window\.ethereum\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/sdk/examples/webhook.ts` returns ZERO. Webhook verification is HMAC, no wallet code.
- Brand discipline: no Claude/Anthropic mentions in the file or commit. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-webhook-example`. Open PR titled `docs(sdk): add examples/webhook.ts end-to-end verification demo`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. sdk-go — doc_test.go testable examples for pkg.go.dev
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(sdk-go): doc_test.go testable examples (pkg.go.dev)',
$$Add `packages/sdk-go/doc_test.go` — a Go-ecosystem-idiomatic file containing `Example*` functions that pkg.go.dev renders inline under each function's documentation page AND that `go test ./...` compile-tests as part of the normal test run. Today the Go SDK has `client.go`, `errors.go`, `retry.go`, `types.go`, `client_test.go`, `doc.go`, `go.mod`, `README.md` — but **no `doc_test.go`** (verify: `ls packages/sdk-go/`).

Why this matters and is not duplication of queued work:
- `quickstart.go` (queued in pass 9db4cb78, PR #253, not yet shipped) is a runnable binary under a future `examples/` directory — invoked by `go run examples/quickstart/main.go`. Different surface.
- `CONTRIBUTING.md` (queued in pass bf6837e4, PR #254, not yet shipped) is markdown documentation.
- `doc_test.go` is a Go convention: example functions named `ExampleClient`, `ExampleClient_Pay`, `ExampleClient_RegisterMerchant`, etc. pkg.go.dev renders them VERBATIM under the function they reference in the auto-generated documentation. `go test` compiles them (catching API drift) and optionally verifies the `// Output:` comment matches stdout.
- The Go community treats a module without doc examples as incomplete documentation — `golangci-lint` even has a check (`exhaustivestruct` adjacent rules) and `go doc -all` surfaces them.

Premissa 23 (SDK-first DX), Premissa 25 (DevRel + open SDK > paid marketing — pkg.go.dev is the canonical Go developer entry point), Premissa 31 (open source SDKs MIT).

Public surface to exercise (read from `packages/sdk-go/client.go` + `doc.go` BEFORE writing):
- `NewClient(cfg ClientConfig) (*Client, error)` — constructor.
- `(*Client).Health(ctx) (HealthStatus, error)` — basic GET.
- `(*Client).RegisterMerchant(ctx, RegisterMerchantInput) (Merchant, error)` — POST with body.
- `(*Client).Pay(ctx, transaction string) (PayResponse, error)` — x402 POST with `X402Header` header (see `client.go` line 167+).
- `X402Header` constant (line 20).
- `ClientConfig` struct fields.

Scope (1 new file, ~80-120 LOC):

1. Create `packages/sdk-go/doc_test.go` with `package zettapay_test` (external test package, so examples import via the module path — match what `client_test.go` uses; if `client_test.go` uses `package zettapay` internal, use `package zettapay_test` for the doc examples since that's what pkg.go.dev rendering expects).
2. Add the import block: `import ("context"; "fmt"; "log"; "time"; "github.com/leandromaiam-code/zettapay/packages/sdk-go" /* AS zettapay */)` — verify the module path against `packages/sdk-go/go.mod`'s `module` declaration BEFORE writing. If the module path is bare `zettapay` (not the GitHub path), use that.
3. Define exactly THREE `Example*` functions (more is scope creep; fewer leaves clear gaps):
   - `func ExampleNewClient()` — construct a `Client` with `ClientConfig{BaseURL: "https://api.zettapay.dev"}` and print the type (e.g., `fmt.Printf("%T\n", client)`). `// Output: *zettapay.Client`.
   - `func ExampleClient_RegisterMerchant()` — illustrate the input struct construction and the context.WithTimeout pattern; print the input field names that get sent (do NOT make a real network call — use the existing `client_test.go` mockito pattern is NOT applicable here, but a NON-runnable example WITHOUT `// Output:` comment is valid in Go and pkg.go.dev still renders it). Leave OFF the `// Output:` line so `go test` does NOT try to execute it against a live server.
   - `func ExampleClient_Pay()` — illustrate the x402 flow: show a placeholder base64-encoded signed tx string (e.g., `signedTx := "AbCDeF...placeholder..."`), call `client.Pay(ctx, signedTx)`, and show how to read the returned `PayResponse`. Reference `X402Header` in a comment so pkg.go.dev cross-links it. NO `// Output:` line.
4. Each Example function has a `// Comment ...` description line ABOVE the function — pkg.go.dev pulls this as the example's summary.
5. The two examples without `// Output:` lines (RegisterMerchant + Pay) MUST compile but will NOT execute their network calls; they exist for documentation rendering on pkg.go.dev. The one with `// Output:` (NewClient) IS executable and verifies the API.
6. Do NOT add new dependencies; module is currently zero-dep (verify against `go.mod`).
7. Do NOT touch `client.go`, `client_test.go`, or any other existing file.

Validation:
- `cd packages/sdk-go && go test -run Example -v ./...` (if Go toolchain available) compiles all three Examples and runs the `// Output:`-bearing one (ExampleNewClient) successfully.
- `cd packages/sdk-go && go vet ./...` reports zero issues.
- `cd packages/sdk-go && go doc -all` includes "Example" sections under Client, RegisterMerchant, Pay.
- `npm run build` unaffected (Go files outside TypeScript build).
- Wallet-less hard rule N/A — pure HTTP example.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-go-doc-test`. Open PR titled `docs(sdk-go): add doc_test.go testable examples for pkg.go.dev`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. docs/concepts/wallet-less.mdx — canonical public concept doc for the HARD-rule
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(concepts): wallet-less architecture concept page',
$$Add `docs/concepts/wallet-less.mdx` — the canonical public concept doc explaining ZettaPay's wallet-less architecture (the HARD-rule from CLAUDE.md: "ZettaPay NUNCA requer conectar carteira. Customer apenas FORNECE a chave publica."). Today `CLAUDE.md` documents the rule for mission workers and the wallet-less CI gate (queued in pass 9db4cb78) enforces it on every PR, but **merchants and integrators reading the public mintlify docs at docs/concepts/ get NO explanation of why ZettaPay never calls `wallet.connect()` or shows a "Connect Wallet" button**.

Current `docs/concepts/` inventory (verify: `ls docs/concepts/`):
- architecture.mdx
- ai-agents.mdx
- native-integrations.mdx
- webhooks.mdx
- onramp.mdx
- beta-launch.mdx

No wallet-less concept page. The closest mentions are scattered: `ai-agents.mdx` mentions x402 + non-custody briefly; `architecture.mdx` references it tangentially. Neither is the canonical reference an integrator can link to from a Stack Overflow answer.

Premissa "HARD RULE — WALLET-LESS ARCHITECTURE (CANONICAL, 2026-05-11)" from CLAUDE.md + Premissa 24 (Documentation site mintlify-style — Z17. Critical for adoption).

Scope (1 new file, ~120-180 LOC mdx):

1. Create `docs/concepts/wallet-less.mdx`.
2. Frontmatter (matches sibling concept docs — read `docs/concepts/webhooks.mdx` for the exact key set):
   ```
   ---
   title: "Wallet-less architecture"
   description: "ZettaPay never requires connecting a wallet. Customers paste a public key; payment happens in any wallet they choose."
   ---
   ```
3. Body sections (use mintlify-flavored MDX components only if the sibling docs already use them — read `docs/concepts/ai-agents.mdx` to see what components are in use, e.g. `<Note>`, `<Card>`, `<CardGroup>`, `<Steps>`):

   - **Why wallet-less** (4-6 paragraphs):
     - Zero install friction (no extension required, works on any device).
     - Customer pays from any wallet they choose — Phantom, Solflare, hardware, mobile, or even an exchange-hosted address.
     - Privacy: ZettaPay never has access to sign requests, only to the destination address the customer entered.
     - Multi-chain by construction: the same pattern works for BTC, ETH, and USDC.
   - **How it works** (numbered list or `<Steps>` if mintlify supports it):
     1. Merchant onboarding: paste pubkey into signup form (no `connect`).
     2. Customer checkout: ZettaPay shows a Solana Pay QR + copyable address.
     3. Customer scans/copies the address into THEIR wallet and pays manually.
     4. ZettaPay monitors on-chain (poll + webhook) for the transaction and notifies the merchant.
   - **What you will NOT see in our SDKs or UI** (bulleted list, copied verbatim from the HARD-rule list in CLAUDE.md):
     - `wallet.connect()`, `wallet-adapter` UI components.
     - `window.solana.connect()`, `window.ethereum.connect()`.
     - "Connect Wallet" / "Connect Phantom" / "Connect MetaMask" buttons.
     - WalletConnect protocol.
   - **What we DO support** (bulleted list):
     - Offline `signMessage` (customer signs in their wallet, pastes hex into our form — used for dashboard auth).
     - `wallet-standard` for read-only detection (purely for UX hints; no `connect`).
     - `@solana/pay` URI generation server-side.
     - Mobile deep links via the `solana:` URI scheme.
   - **For AI agents**: cross-link to `/concepts/ai-agents` and `/guides/x402-protocol` — agents pre-sign the transaction blob and pass it in the `x-402-payment` header; no wallet UI exists in that flow at all.

4. Do NOT modify `docs/docs.json` — sidebar registration is deferred to a separate trivial mission (1-line array insert) to keep this pass strictly single-file. The page is still routable at `/concepts/wallet-less` even without sidebar registration; mintlify renders it on direct navigation. Cross-links from sibling pages and the sitemap will catch it on the next docs:check run.
5. Do NOT touch any other file. No README updates, no sitemap edits, no broken-link sweeps.

Validation:
- `npm run docs:check` (if `mint` CLI installs cleanly) reports no broken links FROM this new page. Broken links INTO this new page are expected (sidebar not registered yet — separate mission).
- `npx -y mint@latest dev --path docs` renders the page at `http://localhost:3000/concepts/wallet-less` if launched locally.
- `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' docs/concepts/wallet-less.mdx` finds matches ONLY inside the "What you will NOT see" bulleted list (those strings appear AS DOCUMENTATION of the banned list, not as live code). The wallet-less CI gate (queued in pass 9db4cb78) is expected to exclude `.mdx` from its scan; if it does NOT, the mission worker must update the gate's exclude pattern as part of this mission OR call out the conflict in the PR description.
- `npm run build` unaffected — mdx files outside the TS build.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-concepts-wallet-less`. Open PR titled `docs(concepts): wallet-less architecture concept page`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. TS SDK — examples/x402.ts AI-agent payment wiring demo
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'docs(sdk): examples/x402.ts AI-agent payment demo',
$$Add `packages/sdk/examples/x402.ts` — a runnable example demonstrating the x402 AI-agent payment wiring through `ZettaPayClient.pay()` and the `X402_HEADER` constant. Today the CANONICAL TS SDK (Premissa 23) ships zero examples; the Rust and Python quickstarts cover the x402 flow but the TS SDK does not.

Why this is fresh and not a repeat-rejection: `packages/sdk/examples/quickstart.ts` was rejected in #258 and #259 because a full quickstart requires choosing whether to bundle `@solana/web3.js` to sign a real tx for the demo or stub it. The `x402.ts` example dodges that dilemma by:
- Using a PLACEHOLDER base64 signed-tx string (the same `'AQID'` / `'AbCdEf...'` pattern already used in `packages/sdk/test/client.test.ts` and `packages/sdk-rust/tests/integration.rs`).
- Calling `client.pay(transaction)` and demonstrating the request shape (header construction, response decoding).
- Documenting in a comment that to run end-to-end the developer must produce a real signed tx with their own wallet tooling — same convention as the Rust + Python `quickstart.*` examples.

Premissa 6 (AI agents pay via x402 header — signed tx blob, spec aberta. Moat via early adoption), Premissa 8 (AI Agent Marketplace é o moat de longo prazo), Premissa 23 (SDK-first DX, TS canonical).

Public surface to exercise (read from `packages/sdk/src/client.ts` + `packages/sdk/src/index.ts` before writing):
- `ZettaPayClient`, `ZettaPayClientOptions`, `PayInput`, `X402_HEADER` constant (all re-exported from index).
- `client.pay(input: PayInput | string | Uint8Array): Promise<PayResponse>` (`client.ts` line 56).
- `PayResponse` type re-exported from `types.ts`.
- `client.getPayment(id)` for the post-pay confirmation read.

Scope (1 new file, ~80-120 LOC):

1. Create `packages/sdk/examples/x402.ts`.
2. Header docstring (`/** ... */`):
   - Title: `End-to-end ZettaPay TS SDK x402 AI-agent payment wiring`
   - `## Run` section: `npx tsx examples/x402.ts` (with optional `ZETTAPAY_BASE_URL` and `ZETTAPAY_SIGNED_TX_BASE64` env vars — same convention as the Rust and Python quickstarts).
   - One-line scope statement: "Demonstrates X402_HEADER wiring through ZettaPayClient.pay(); does NOT sign transactions (use your own wallet tooling — this SDK is wallet-less by design)."
3. Demonstrate the flow in a top-level `async function main()`:
   - Read `baseURL` from `process.env.ZETTAPAY_BASE_URL ?? 'http://localhost:3000'`.
   - Read `signedTx` from `process.env.ZETTAPAY_SIGNED_TX_BASE64 ?? null`.
   - Construct `const client = new ZettaPayClient({ baseURL });`.
   - Print `→ ZettaPay x402 demo against ${baseURL}` and `→ X-402 header name: ${X402_HEADER}` (cross-references the constant).
   - If `signedTx` is set: call `const receipt = await client.pay(signedTx);` and print `✓ pay: accepted=${receipt.accepted} payment_id=${receipt.payment_id} feePayer=${receipt.feePayer}`. Then `const record = await client.getPayment(receipt.payment_id);` and print `✓ get_payment: id=${record.id} signers=${record.signers.length}`.
   - If `signedTx` is NOT set: print `→ pay step skipped (set ZETTAPAY_SIGNED_TX_BASE64 to exercise /pay)`. Then demonstrate the wire-shape: pretty-print a sample request shape `{ method: 'POST', url: '/pay', headers: { [X402_HEADER]: '<base64 signed tx>' } }` so the reader sees the protocol-level shape without needing a real tx.
4. Import from the package root: `import { ZettaPayClient, X402_HEADER, type PayInput } from '../src/index.js';` (relative path so the example is runnable directly with `tsx` from `packages/sdk/`).
5. Provide `main().catch((err) => { console.error(err); process.exit(1); });` at the bottom.
6. Do NOT modify `src/client.ts` — examples only.
7. Do NOT add `@solana/web3.js` or any other new dependency. Do NOT actually sign a transaction in the example. The placeholder demonstrates the protocol shape; signing is the integrator's responsibility (and they will use whatever wallet tooling they prefer — wallet-less HARD-rule).
8. Do NOT create `packages/sdk/examples/README.md`, `examples/quickstart.ts`, or any other example file — separate missions.

Validation:
- `node --import tsx packages/sdk/examples/x402.ts` exits 0 and prints the `→` log lines + (if `ZETTAPAY_SIGNED_TX_BASE64` is unset, which it will be in CI) the `→ pay step skipped` message and the sample request-shape pretty-print. No exceptions.
- `npx tsc --noEmit --module nodenext --moduleResolution nodenext --target es2022 --strict packages/sdk/examples/x402.ts` typechecks clean.
- `npm run build` unaffected — `packages/sdk/tsconfig.json` does not include `examples/`.
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|window\.ethereum\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/sdk/examples/x402.ts` returns ZERO. The example is wallet-less by construction — the customer/agent produces the signed tx OUTSIDE the SDK and only the base64 blob enters the SDK surface.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-x402-example`. Open PR titled `docs(sdk): add examples/x402.ts AI-agent payment wiring demo`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. widget — public re-export surface stability test
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'test(widget): index.ts public re-export surface stability',
$$Add `packages/widget/test/index.test.ts` — a vitest spec that locks the public re-export surface of `packages/widget/src/index.ts` (the canonical `@zettapay/widget` entry point) against accidental rename / removal. Today the widget package has `packages/widget/test/widget.test.ts` (covering `widget.ts` internals) but NOTHING that asserts the PUBLIC entry-point surface — `mount`, `open`, `version`, and the type re-exports. A future refactor that drops a re-export ships silently.

Why this is fresh:
- `packages/widget/test/qr.test.ts` is queued in pass 2e05f052 (PR #245) — covers `qr.ts`, not `index.ts`.
- `packages/widget/test/api.test.ts` is queued in pass 07b1ae9c (PR #261) — covers `api.ts`, not `index.ts`.
- `packages/widget/test/{modal,styles}.test.ts` were rejected in prior refills as DOM-coupled, needs scaffolding — NOT what THIS mission ships.
- `packages/widget/test/widget.test.ts` exists on main but tests `widget.ts` internals, NOT the index re-export surface.

Premissa 27 (Quality Gate: missions <30 score blocked, ≥60 auto-approve), Premissa 29 (Tech debt @ts-nocheck só permitido em código legacy. Zero em código novo — the regression-catch is exactly the kind of guard that prevents @ts-nocheck workarounds in the embed/widget surfaces downstream).

Public surface to lock (read from `packages/widget/src/index.ts` BEFORE writing):
- Named function exports: `mount`, `open`.
- Named const export: `version` (string).
- Type re-exports: `WidgetConfig`, `WidgetOpenEvent`, `WidgetSuccessEvent`, `WidgetCancelEvent`, `WidgetErrorEvent`, `WidgetPostMessage`, `PaymentIntent` (verify exact list against `src/index.ts` — if it has changed since this spec was written, the test must match what is CURRENTLY exported, not this spec's list).

Scope (1 new file, ~50-80 LOC):

1. Create `packages/widget/test/index.test.ts`.
2. Vitest config (`packages/widget/vitest.config.ts`) already sets `environment: 'happy-dom'`, so `document` IS available in the test environment. The new file may need to GUARD against auto-init side effects — `src/index.ts` runs `autoInit()` synchronously when imported in a `document !== undefined` env. The test must either (a) clear `document.body` before assertions, OR (b) import in a `beforeAll` after stubbing `document.querySelectorAll` to return an empty NodeList. Pick (a) — simpler.
3. Test cases (one `describe('@zettapay/widget public surface', ...)` block):
   - `it('exports mount as a function')` — `import { mount } from '../src/index.js'; expect(typeof mount).toBe('function');`
   - `it('exports open as a function')` — `import { open } from '../src/index.js'; expect(typeof open).toBe('function');`
   - `it('exports version as a string')` — `import { version } from '../src/index.js'; expect(typeof version).toBe('string'); expect(version.length).toBeGreaterThan(0);`
   - `it('auto-init is a no-op when no data-merchant scripts are present')` — `document.body.innerHTML = '';` then dynamic-import the module fresh (via `vi.resetModules()` + `await import('../src/index.js')`) and assert `document.querySelectorAll('[data-zettapay-target]').length === 0`. This locks the auto-init contract: zero side effects when the host page does not opt in.
4. Use TOP-LEVEL static imports for the first 3 tests; use dynamic re-import (after `vi.resetModules()`) ONLY for the auto-init test where the side-effect surface matters.
5. Do NOT test `mount()` / `open()` behavior (DOM rendering, message-event plumbing) — those are `widget.test.ts` + the queued `api.test.ts` / `qr.test.ts` jobs. THIS test ONLY locks the SHAPE of the public surface.
6. Do NOT modify `src/index.ts` or any other source file.

Validation:
- `cd packages/widget && npx vitest run test/index.test.ts` passes all 4 cases.
- `cd packages/widget && npx vitest run` (the full widget test suite) passes — no regressions to `widget.test.ts`.
- `npm run build --workspace @zettapay/widget` unaffected.
- Wallet-less hard rule: `grep -E 'wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask' packages/widget/test/index.test.ts` returns ZERO.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-index-surface-test`. Open PR titled `test(widget): lock public re-export surface (mount, open, version)`.$$,
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
     'mission_uuid_prefix', '843972bd',
     'generated_at', '2026-05-17',
     'companion_doc', 'docs/discovery/843972bd-backlog-refill.md',
     'companion_sql', 'docs/discovery/843972bd-backlog-refill.sql',
     'mission_names', jsonb_build_array(
       'docs(sdk): examples/webhook.ts end-to-end demo',
       'docs(sdk-go): doc_test.go testable examples (pkg.go.dev)',
       'docs(concepts): wallet-less architecture concept page',
       'docs(sdk): examples/x402.ts AI-agent payment demo',
       'test(widget): index.ts public re-export surface stability'
     ),
     'themes', jsonb_build_array(
       'TS-SDK-examples-bootstrap (webhook.ts + x402.ts) — canonical SDK had no examples/ dir; both picks dodge the @solana/web3.js bundling dilemma that blocked quickstart.ts in #258 + #259',
       'sdk-go-doc_test.go (pkg.go.dev ecosystem-idiomatic testable examples — orthogonal to queued quickstart.go + CONTRIBUTING.md)',
       'docs/concepts/wallet-less.mdx (canonical public concept doc for the HARD-rule — CLAUDE.md only documents it internally)',
       'widget/test/index.test.ts (public re-export surface stability — orthogonal to queued qr.test + api.test)'
     ),
     'avoided_repeat_rejections', jsonb_build_array(
       'packages/sdk/examples/quickstart.ts (@solana/web3.js bundling decision — rejected in #258 + #259; replaced this pass with webhook.ts + x402.ts which have no such dep)',
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
     'deferred_until_dependency_ships', jsonb_build_array(
       'docs.json sidebar registration for /concepts/wallet-less (trivial 1-line array insert; deferred to keep THIS pass strictly single-file per mission)',
       'packages/sdk/examples/README.md (deferred until at least 2 example files have shipped)',
       'packages/sdk-go/examples/x402.go (sdk-go quickstart.go itself queued in 9db4cb78 and not yet shipped — example follows source)',
       'packages/sdk-php/examples/x402.php (sdk-php quickstart.php queued in bf6837e4 and not yet shipped)'
     ),
     'prior_refill_chain', jsonb_build_array(
       '#262 (c08a7f17)', '#261 (07b1ae9c)', '#260 (03cf9a17)', '#259 (e365137f)',
       '#258 (66b549af)', '#257 (d5806497)', '#254 (bf6837e4)', '#253 (9db4cb78)',
       '#252 (a82d92db)', '#251 (1986ee3d)', '#245 (2e05f052)', '#244 (4f79ec06)',
       '#242 (69cdcbce)', '#231 (fba46358)'
     )
   ));
