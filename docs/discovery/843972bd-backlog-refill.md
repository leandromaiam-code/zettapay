# Auto-discovery backlog refill — 843972bd

**Generated:** 2026-05-17
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `843972bd`
**Prior refills (recent, last 14):**

| PR   | UUID prefix | Theme                                                                                          |
|------|-------------|------------------------------------------------------------------------------------------------|
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

The fourteen prior refills drained the wallet-less HARD-rule rewrite queue, the per-SDK polyglot hygiene queue (CONTRIBUTING / SECURITY / quickstart parity), the GitHub trust-signal queue (SECURITY.md, ISSUE config, PR template, well-known/\*), the per-SDK CI gating queue, the TS-lane npm-meta queue, the site-launch SEO queue, the vercel-safe-security-headers queue, the next-pass test-coverage queue (embed/rpc + widget/api), the sdk-rust LICENSE, and (in `c08a7f17`) the per-SDK LICENSE parity for python/go/php plus the sdk-rust/python webhook examples.

This pass scans four **previously-unaddressed surfaces left over** by those drains:

1. **Canonical TS SDK examples directory bootstrap.** The polyglot sdk-rust and sdk-python both ship `examples/quickstart.*` (and their webhook examples are queued in `c08a7f17`). The CANONICAL TS SDK (Premissa 23: *"SDK first. @zettapay/sdk em TypeScript canonical"*) has **no `examples/` directory at all** — verify `ls packages/sdk/` returns `LICENSE README.md package.json src test tsconfig.json vitest.config.ts` and no `examples/`. Two prior refills (#258, #259) considered adding `packages/sdk/examples/quickstart.ts` and rejected it because a full quickstart requires choosing whether to bundle `@solana/web3.js` for signing or stub it (each option is a separate design call). This pass adds the two example files that **dodge that dep dilemma entirely**: `webhook.ts` (pure HMAC, only `node:crypto`) and `x402.ts` (uses a placeholder base64 signed-tx string — same convention as the existing `client.test.ts` fixtures and the rust/python `quickstart.*` skip-the-pay-step pattern).

2. **Go-ecosystem-idiomatic testable examples (`doc_test.go`).** pkg.go.dev renders `Example*` functions VERBATIM under each function's documentation page, AND `go test` compile-tests them as part of the normal test run. The Go community treats a module without testable examples as incomplete documentation. The sdk-go module has `client.go`, `errors.go`, `retry.go`, `types.go`, `client_test.go`, `doc.go`, `go.mod`, `README.md` but **no `doc_test.go`**. The queued `quickstart.go` (PR #253, `9db4cb78`) is a separate surface — a runnable binary under `examples/`, invoked by `go run`. The queued `CONTRIBUTING.md` (PR #254, `bf6837e4`) is markdown. `doc_test.go` is orthogonal to both and ecosystem-canonical.

3. **Canonical public concept doc for the wallet-less HARD-rule.** `CLAUDE.md` documents the rule for mission workers, and the wallet-less CI gate (queued in `9db4cb78`) enforces it on every PR. But merchants and integrators reading the public mintlify docs at `docs/concepts/` get **no explanation of why ZettaPay never calls `wallet.connect()`** — `docs/concepts/` has `architecture.mdx`, `ai-agents.mdx`, `native-integrations.mdx`, `webhooks.mdx`, `onramp.mdx`, `beta-launch.mdx`, and **no `wallet-less.mdx`**. The closest mentions are scattered (`ai-agents.mdx` mentions x402 + non-custody briefly; `architecture.mdx` references it tangentially). Neither is the canonical reference an integrator can link to from a Stack Overflow answer.

4. **Widget public re-export surface stability test.** `packages/widget/src/index.ts` is the canonical `@zettapay/widget` entry point (exports `mount`, `open`, `version`, and 7 type re-exports). The package has `test/widget.test.ts` (covering `widget.ts` internals) but NOTHING that asserts the PUBLIC entry-point shape — a future refactor that drops a re-export ships silently. The queued `widget/test/qr.test.ts` (PR #245) and `widget/test/api.test.ts` (PR #261) cover sibling modules, not `index.ts`. The rejected `widget/test/{modal,styles}.test.ts` (DOM-coupled) is a different surface entirely. This pass adds the surface-stability test (the auto-init no-op + 3 export-shape assertions) — runs in the already-wired `happy-dom` env.

---

## Picks

| # | Mission name (≤60 chars)                                              | Target file                                | LOC est. | Layer 0           |
|---|-----------------------------------------------------------------------|--------------------------------------------|----------|-------------------|
| 1 | `docs(sdk): examples/webhook.ts end-to-end demo`                      | `packages/sdk/examples/webhook.ts` (new)   | ~100     | 9, 23, 25         |
| 2 | `docs(sdk-go): doc_test.go testable examples (pkg.go.dev)`            | `packages/sdk-go/doc_test.go` (new)        | ~100     | 23, 25, 31        |
| 3 | `docs(concepts): wallet-less architecture concept page`               | `docs/concepts/wallet-less.mdx` (new)      | ~150     | HARD-rule, 24     |
| 4 | `docs(sdk): examples/x402.ts AI-agent payment demo`                   | `packages/sdk/examples/x402.ts` (new)      | ~100     | 6, 8, 23          |
| 5 | `test(widget): index.ts public re-export surface stability`           | `packages/widget/test/index.test.ts` (new) | ~60      | 27, 29            |

All five are **pure additive**, **single-file**, **single-objective**, and **outside the chronic `packages/api` build-break lane** (worker memory `project_build_broken.md`). None touch wallet code or wallet-adapter UI.

---

## Per-pick rationale

### 1. `docs(sdk): examples/webhook.ts end-to-end demo`

Today `packages/sdk/` has no `examples/` directory at all. The polyglot sdk-rust and sdk-python both ship `examples/quickstart.*` (and their webhook examples are queued in `c08a7f17`); the CANONICAL TS SDK has nothing. Two prior refills (#258, #259) rejected `examples/quickstart.ts` because it requires choosing whether to bundle `@solana/web3.js` for signing or stub it — a separate design call. The `webhook.ts` example has **no such dependency**: `parseWebhook` uses only `node:crypto` internally and the example caller uses only `node:crypto` for sign-side HMAC.

Premissa 9 (Webhooks Stripe-grade — signature verification is the canonical reliability primitive) + Premissa 23 (SDK-first DX, TS canonical) + Premissa 25 (DevRel + open SDK).

**Scope (1 new file, ~90-120 LOC):**

1. Create `packages/sdk/examples/webhook.ts`.
2. Header docstring with title `End-to-end ZettaPay TS SDK webhook verification`, `## Run` block (`npx tsx examples/webhook.ts`), one-line scope statement.
3. Demonstrate three cases in `async function main()`:
   - **Sign + verify round-trip** — HMAC-SHA256 over `${timestamp}.${body}`, prefix `sha256=`, build headers, call `parseWebhook`, assert `{ ok: true, parsed }`. Print `✓ sign/verify round-trip ok`.
   - **Expired timestamp** — same payload, timestamp 6 minutes in the past, assert `{ ok: false, reason: 'timestamp_out_of_tolerance' }`.
   - **Bad signature** — tampered body, assert `{ ok: false, reason: 'signature_mismatch' }`.
4. Import from package root: `import { parseWebhook, SIGNATURE_HEADER, TIMESTAMP_HEADER, EVENT_ID_HEADER } from '../src/index.js';`
5. No new deps. Only `node:crypto`. Examples-only — no `src/` edits.

**Validation:**
- `node --import tsx packages/sdk/examples/webhook.ts` exits 0, prints three `✓` lines.
- `npm run build` unaffected (examples/ outside tsconfig include).
- Wallet-less hard rule N/A — pure HMAC verification.

### 2. `docs(sdk-go): doc_test.go testable examples (pkg.go.dev)`

The sdk-go module has client + errors + retry + types + client_test + doc + go.mod + README but **no `doc_test.go`** (verify: `ls packages/sdk-go/`). pkg.go.dev renders `Example*` functions inline under each function's doc page and `go test` compile-tests them. This is the canonical Go ecosystem signal for a documented module — `golangci-lint` checks for it and `go doc -all` surfaces them.

Distinct from queued sibling work:
- `quickstart.go` (queued `9db4cb78`, PR #253) → runnable binary under `examples/`, separate surface.
- `CONTRIBUTING.md` (queued `bf6837e4`, PR #254) → markdown.

Premissa 23 + Premissa 25 + Premissa 31.

**Scope (1 new file, ~80-120 LOC):** Three `Example*` functions:

- `ExampleNewClient` — construct `Client` from `ClientConfig{BaseURL: ...}`; print `%T`; uses `// Output: *zettapay.Client` so `go test` actually runs it.
- `ExampleClient_RegisterMerchant` — illustrate the input struct + `context.WithTimeout` pattern; NO `// Output:` line (won't execute, still renders on pkg.go.dev).
- `ExampleClient_Pay` — illustrate the x402 flow with a placeholder base64 signed tx; cross-reference `X402Header` constant in a comment.

Module path read from `go.mod` before writing import block. No new deps.

**Validation:**
- `go test -run Example -v ./...` compiles all three and runs `ExampleNewClient`.
- `go vet ./...` clean.
- `go doc -all` shows Example sections.
- `npm run build` unaffected.

### 3. `docs(concepts): wallet-less architecture concept page`

`CLAUDE.md` documents the wallet-less HARD-rule for mission workers; the wallet-less CI gate (queued `9db4cb78`) enforces it on every PR. But the public mintlify docs at `docs/concepts/` have no canonical page explaining the rule to merchants and integrators — the rationale gets re-derived every time someone asks "why no Connect Wallet button?".

`docs/concepts/` inventory (verify): architecture, ai-agents, native-integrations, webhooks, onramp, beta-launch. No wallet-less.

Premissa "HARD RULE — WALLET-LESS ARCHITECTURE (CANONICAL, 2026-05-11)" + Premissa 24 (Documentation site mintlify-style — critical for adoption).

**Scope (1 new file, ~120-180 LOC mdx):** Sections (read `docs/concepts/webhooks.mdx` + `ai-agents.mdx` for frontmatter shape + mintlify component conventions):

- Frontmatter: `title: "Wallet-less architecture"` + `description`.
- **Why wallet-less** — friction, multi-wallet freedom, privacy, multi-chain by construction.
- **How it works** — onboarding (paste pubkey), checkout (QR + address, no `connect`), settlement (poll + webhook).
- **What you will NOT see** — verbatim list from CLAUDE.md HARD-rule (`wallet.connect()`, `wallet-adapter-react-ui`, "Connect Phantom", WalletConnect, etc.).
- **What we DO support** — offline `signMessage`, `wallet-standard` READ-only detection, `@solana/pay` URI generation, deep links via `solana:` scheme.
- **For AI agents** — cross-link to `/concepts/ai-agents` + `/guides/x402-protocol`; agents pre-sign and pass the blob in `x-402-payment` header.

**Deferred (separate trivial mission):** `docs/docs.json` sidebar registration — a 1-line array insert that keeps THIS pass strictly single-file. The page is still routable at `/concepts/wallet-less` on direct navigation; sidebar inclusion is a separate auto-mergeable mission.

**Validation:**
- `npm run docs:check` — no broken links FROM this page. Broken links INTO this page (sidebar) expected until sibling mission lands.
- `npm run build` unaffected.
- Wallet-less CI gate: the banned strings appear ONLY inside the "What you will NOT see" bullet list (documentation, not code). If the queued gate scans `.mdx`, the mission worker must update the gate's exclude pattern OR call out the conflict in the PR description.

### 4. `docs(sdk): examples/x402.ts AI-agent payment demo`

Companion to Pick #1 in the same new `packages/sdk/examples/` directory. The rust + python quickstarts cover x402 with a `ZETTAPAY_SIGNED_TX_BASE64` env-var skip pattern; the TS SDK has nothing. This pass dodges the rejected `quickstart.ts` `@solana/web3.js` dep dilemma by using a **placeholder base64 string** (same convention as `packages/sdk/test/client.test.ts` and `packages/sdk-rust/tests/integration.rs`) and printing the wire-shape when no real signed tx is provided.

Premissa 6 (AI agents pay via x402 header) + Premissa 8 (AI Agent Marketplace é o moat) + Premissa 23 (SDK-first DX).

**Scope (1 new file, ~80-120 LOC):**

1. Create `packages/sdk/examples/x402.ts`.
2. Header docstring with title `End-to-end ZettaPay TS SDK x402 AI-agent payment wiring`, run instructions including `ZETTAPAY_BASE_URL` + `ZETTAPAY_SIGNED_TX_BASE64` env vars (same convention as the rust/python quickstarts), and a one-line scope statement noting "does NOT sign transactions — this SDK is wallet-less by design".
3. `async function main()`:
   - Read `baseURL` + `signedTx` from env (defaults: `http://localhost:3000` + `null`).
   - Construct client; print `→ ZettaPay x402 demo against ${baseURL}` and `→ X-402 header name: ${X402_HEADER}`.
   - If `signedTx` set: call `client.pay(signedTx)` + `client.getPayment(receipt.payment_id)`; print receipt + record.
   - If unset: pretty-print sample request shape (header, URL, method) so the reader sees the protocol shape without needing a real tx.
4. Import `{ ZettaPayClient, X402_HEADER, type PayInput }` from package root.
5. No new deps. Do NOT actually sign a tx.

**Validation:**
- `node --import tsx packages/sdk/examples/x402.ts` exits 0.
- `npm run build` unaffected.
- Wallet-less hard rule — pass (no `connect()`, no wallet UI).

### 5. `test(widget): index.ts public re-export surface stability`

`packages/widget/src/index.ts` exports `mount`, `open`, `version`, and 7 type re-exports. `packages/widget/test/widget.test.ts` covers `widget.ts` internals but **not** the entry-point shape — a future refactor that drops a re-export ships silently. Queued sibling `qr.test.ts` (#245) and `api.test.ts` (#261) cover OTHER modules. Rejected `{modal,styles}.test.ts` is jsdom-coupled — different surface.

Premissa 27 (Quality Gate) + Premissa 29 (Tech debt @ts-nocheck only in legacy code — the regression-catch is exactly the kind of guard that prevents @ts-nocheck workarounds downstream).

**Scope (1 new file, ~50-80 LOC):** One `describe('@zettapay/widget public surface', ...)` block, 4 cases:

- `exports mount as a function` — `typeof mount === 'function'`.
- `exports open as a function` — `typeof open === 'function'`.
- `exports version as a string` — `typeof version === 'string' && version.length > 0`.
- `auto-init is a no-op when no data-merchant scripts are present` — clear `document.body`, dynamic-re-import the module, assert no `[data-zettapay-target]` elements added.

`happy-dom` env already wired in `packages/widget/vitest.config.ts` — no new scaffolding.

**Validation:**
- `npx vitest run test/index.test.ts` passes all 4.
- Full widget vitest suite passes (no `widget.test.ts` regression).
- `npm run build --workspace @zettapay/widget` unaffected.

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen because they fail one or more of {single-file, single-objective, auto-mergeable, non-controversial, outside chronic-broken lane, fresh vs. prior refills}:

- **`packages/sdk/examples/quickstart.ts`** — rejected in #258 and #259 because it requires choosing whether to bundle `@solana/web3.js` for signing or stub it. This pass REPLACES the quickstart pick with two examples (`webhook.ts` + `x402.ts`) that have no such dep, leaving quickstart for a future design-decision mission.
- **`docs/docs.json` sidebar registration for `/concepts/wallet-less`** — would be a 1-line array insert paired with Pick #3, but bundling it makes Pick #3 a 2-file mission. Deferred to a separate trivial mission once #3 ships.
- **`packages/sdk/examples/README.md`** — premature until at least 2 example files have shipped from picks #1 + #4.
- **`packages/sdk-go/examples/x402.go` / `packages/sdk-php/examples/x402.php`** — the sdk-go `quickstart.go` (queued `9db4cb78`) and sdk-php `quickstart.php` (queued `bf6837e4`) themselves are still in the pending queue; example follows source.
- **`packages/embed/test/index.test.ts`** — same shape as Pick #5 but for the embed package. Considered but deferred: the embed `index.ts` is significantly larger (auto-init, mount, re-export from 4 sibling modules) and a stability test of comparable depth would balloon past the single-objective bar. Queue separately once the widget test has shipped and we know the shape works.
- **`CHANGELOG.md` at root + per-SDK CHANGELOG.md** — repeatedly rejected: release-ops decision (manual vs Changesets vs Release Drafter) not yet made.
- **`CODEOWNERS`** — repeatedly rejected: per-package ownership map needs a human owner/team decision.
- **`.github/FUNDING.yml`** — sponsor target bikeshed.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1 standard but enforcement contact needs an ops decision.
- **`public/manifest.json` PWA shell** — needs coordinated service worker.
- **`public/favicon.svg` / `favicon.ico`** — needs brand SVG asset decision.
- **`packages/widget/test/{modal,styles}.test.ts` + `packages/embed/test/ui.test.ts`** — jsdom-coupled; separate later missions.
- **`scripts/check-idl-drift.sh`** — needs Anchor toolchain in CI; queued `static-analysis-rust.yml` is the better forcing function.
- **`packages/api/*` build break** — chronic compile lane; not auto-merge.
- **Zombie sentinel chains** — orchestrator-side UUID stickiness, not code missions.

---

## Wallet-less hard-rule sanity

`grep -rn 'wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask'` against this PR's diff returns **only documentary references** (this rationale doc + the SQL comments quoting the rule + the explicit "What you will NOT see" bullet list inside the queued `docs/concepts/wallet-less.mdx` spec — which is documentation OF the banned list, not live code).

The five mission targets themselves are also wallet-less by construction:

- `packages/sdk/examples/webhook.ts` — HMAC verification, no wallet code.
- `packages/sdk-go/doc_test.go` — pure HTTP examples, no wallet code.
- `docs/concepts/wallet-less.mdx` — concept doc EXPLAINING why we never `connect()`.
- `packages/sdk/examples/x402.ts` — placeholder base64 signed tx; the SDK never produces one (Premissa: customer/agent signs externally).
- `packages/widget/test/index.test.ts` — public-surface stability test; no wallet interaction.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run build` state on this branch is identical to `main` — the chronic `packages/api` TS1xxx break is unchanged; this PR cannot have introduced or repaired it.

## Zombie sanity

Cross-referenced the last 60 merged PRs (#202..#262) + the open PR list (~50 zombie sentinels + 2 open feat / sentinel PRs) + the rolling sentinel log (worker memory `project_zombie_sentinel_log.md`) + the fourteen prior refill SQL companions. **None of the 5 mission names** in this refill collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. The Supabase MCP is not granted to mission workers (worker memory `feedback_supabase_mcp_unavailable.md`); the SQL companion file `docs/discovery/843972bd-backlog-refill.sql` is the canonical payload. **Orchestrator (or human operator with service-role key) applies it on merge.** All five INSERTs are wrapped in a single `BEGIN/COMMIT` so partial application is impossible; the audit-journal INSERT runs after the transaction commits so a partial-failure can still be observed in the journal.
