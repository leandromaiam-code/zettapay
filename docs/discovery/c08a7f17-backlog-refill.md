# Auto-discovery backlog refill — c08a7f17

**Generated:** 2026-05-17
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `c08a7f17`
**Prior refills (recent, last 13):**

| PR   | UUID prefix | Theme                                                                                  |
|------|-------------|----------------------------------------------------------------------------------------|
| #261 | `07b1ae9c`  | vercel safe security headers + embed/rpc + widget/api tests + sdk-rust LICENSE + SUPPORT.md |
| #260 | `03cf9a17`  | TS SDK client.ts tests + .nvmrc + .well-known/security.txt + sdk-rust/python CI        |
| #259 | `e365137f`  | wallet-less HARD-rule rewrites + sdk-php Packagist support                             |
| #258 | `66b549af`  | npm metadata (sdk/embed/widget) + .gitattributes + sdk-ts CONTRIBUTING                 |
| #257 | `d5806497`  | sdk-php CONTRIBUTING + SECURITY.md + PR template + ISSUE config + sdk-php Exception tests |
| #254 | `bf6837e4`  | sdk-php quickstart + sdk-go CONTRIBUTING + sdk-python test_types + CodeQL + .tool-versions |
| #253 | `9db4cb78`  | sdk-rust error inline tests + sdk-go quickstart + sitemap + wallet-less CI gate + root CONTRIBUTING |
| #252 | `a82d92db`  | sdk-go errors/retry tests + sdk-python errors test + .well-known/mcp.json + .editorconfig |
| #251 | `1986ee3d`  | sdk-go/sdk-php webhook verifiers + sdk-php CI + dependabot + embed size budget         |
| #245 | `2e05f052`  | widget/qr.test + embed/poll.test + HALL_OF_FAME + llms.txt + static-analysis-rust CI   |
| #244 | `4f79ec06`  | sdk-python/sdk-rust re-exports + vercel CORS + api/pay rate-limit headers + api/index discovery sync |
| #242 | `69cdcbce`  | OG meta + /simulate footer removal + robots/sitemap + pay.html lang + signup hardening |
| #231 | `fba46358`  | sdk-python/sdk-rust webhook verifiers + sdk/errors.ts tests + LOG_PRETTY env doc       |

The thirteen prior refills drained the wallet-less HARD-rule rewrite queue, the per-SDK polyglot hygiene queue (CONTRIBUTING / SECURITY / quickstart parity), the GitHub trust-signal queue (SECURITY.md, ISSUE config, PR template, well-known/*), the per-SDK CI gating queue, the TS-lane npm-meta queue, the site-launch SEO queue, the vercel-safe-security-headers queue, the next-pass test-coverage queue (embed/rpc + widget/api), and the sdk-rust LICENSE.

This pass scans two **previously-unaddressed surfaces left over** by those drains:

1. **Per-SDK LICENSE parity for the three remaining SDKs** — sdk-rust shipped its LICENSE file in pass `07b1ae9c` (PR #261). The prior reviewer explicitly rejected the bundle of {sdk-python, sdk-go, sdk-php} as "each is a separate single-file mission, ordered by publication priority". This pass picks all three up — each as its own single-file mission — because each registry's discoverability surface (PyPI's project page, pkg.go.dev's module page, Packagist's package page) renders the LICENSE file inline and downgrades packages that don't ship one.

2. **Per-SDK `examples/webhook.*` parity** — the SDK-rust and SDK-python source webhook verifiers landed in PR #235 / #236 (`sdk-python: parse_webhook` + `sdk-rust: webhook verifier`), but neither shipped a runnable `examples/webhook.*` file. Both crates have `examples/quickstart.*` (covering the HTTP client) but no parallel example showing the webhook-signature verification flow that merchants need to wire up first. This pass adds both example files — single-file each, mirrors the existing `quickstart.*` shape, calls only public exports.

---

## Picks

| # | Mission name (≤60 chars)                                           | Target file                                          | LOC est. | Layer 0           |
|---|--------------------------------------------------------------------|------------------------------------------------------|----------|-------------------|
| 1 | `chore(sdk-python): LICENSE at package root (PyPI)`                | `packages/sdk-python/LICENSE` (new)                  | ~21      | 23, 31            |
| 2 | `chore(sdk-go): LICENSE at module root (pkg.go.dev)`               | `packages/sdk-go/LICENSE` (new)                      | ~21      | 23, 31            |
| 3 | `chore(sdk-php): LICENSE at package root (Packagist)`              | `packages/sdk-php/LICENSE` (new)                     | ~21      | 23, 31            |
| 4 | `docs(sdk-rust): examples/webhook.rs end-to-end demo`              | `packages/sdk-rust/examples/webhook.rs` (new)        | ~90      | 9, 23, 25         |
| 5 | `docs(sdk-python): examples/webhook.py end-to-end demo`            | `packages/sdk-python/examples/webhook.py` (new)      | ~90      | 9, 23, 25         |

All five are **pure additive**, **single-file**, **single-objective**, and **outside the chronic `packages/api` build-break lane** (worker memory `project_build_broken.md`). None touch wallet code or wallet-adapter UI.

---

## Per-pick rationale

### 1. `chore(sdk-python): LICENSE at package root (PyPI)`

Today `packages/sdk-python/pyproject.toml` declares `license = { text = "MIT" }` but the package root has **no LICENSE file**. PyPI's project page renders the LICENSE file inline (under the "License" sidebar entry) when one is present in the source distribution; without it, PyPI shows only the SPDX identifier from `pyproject.toml`. setuptools' `[project]` metadata supports `license-files = ["LICENSE*"]` for modern PEPs, but the file itself must exist on disk.

Premissa 31 ("Open source: protocol spec + SDKs MIT") + Premissa 23 (SDK-first DX).

**Scope (1 new file, ~21 LOC — verbatim MIT text):**

1. Create `packages/sdk-python/LICENSE` containing the exact same MIT text as the repository root `LICENSE`. Copy verbatim — do NOT modify the copyright holder line.
2. Do NOT modify `packages/sdk-python/pyproject.toml`. The `license = { text = "MIT" }` field is already correct; adding `license-files = ["LICENSE"]` is a separate setuptools-modernization mission.
3. Do NOT touch `packages/sdk-go/` or `packages/sdk-php/` — those are separate missions.

**Validation:**
- `diff packages/sdk-python/LICENSE LICENSE` returns no diff (file is verbatim copy).
- `npm run build` unaffected (Python files outside TypeScript build).
- Wallet-less hard rule N/A — plain text.

### 2. `chore(sdk-go): LICENSE at module root (pkg.go.dev)`

Today `packages/sdk-go/` has `client.go`, `errors.go`, `retry.go`, `types.go`, `client_test.go`, `go.mod`, `README.md`, `doc.go` — but **no LICENSE file**. pkg.go.dev refuses to render a module's documentation page if it cannot detect a license at the module root (it shows a "License: Unknown" warning and de-prioritizes the module in search). The Go ecosystem's `licensecheck` tool (used by Google's Open Source compliance scanner and required by many enterprise allowlists) likewise depends on a `LICENSE` file at the module root.

Premissa 31 + Premissa 23.

**Scope (1 new file, ~21 LOC — verbatim MIT text):**

1. Create `packages/sdk-go/LICENSE` containing the exact same MIT text as the repository root `LICENSE`. Copy verbatim.
2. Do NOT modify `packages/sdk-go/go.mod` — Go modules do not have a license declaration field; the LICENSE file at module root is the canonical signal.
3. Do NOT add a `LICENSE` header comment in each `.go` file — that's a separate convention; the module-root LICENSE is what pkg.go.dev consumes.
4. Do NOT touch `packages/sdk-python/` or `packages/sdk-php/`.

**Validation:**
- `diff packages/sdk-go/LICENSE LICENSE` returns no diff.
- `cd packages/sdk-go && go vet ./...` (if Go toolchain available) is unaffected — LICENSE is not compiled.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.

### 3. `chore(sdk-php): LICENSE at package root (Packagist)`

Today `packages/sdk-php/composer.json` declares `"license": "MIT"` but the package root has **no LICENSE file**. Packagist's package page renders the LICENSE file inline (when present in the source distribution), and Composer's package discovery surfaces "Has LICENSE file: ✓" or "✗" in the package metadata. Some enterprise Composer mirrors (Repman, Private Packagist) refuse to mirror packages with `license` in `composer.json` but no `LICENSE` on disk.

Premissa 31 + Premissa 23.

**Scope (1 new file, ~21 LOC — verbatim MIT text):**

1. Create `packages/sdk-php/LICENSE` containing the exact same MIT text as the repository root `LICENSE`. Copy verbatim.
2. Do NOT modify `packages/sdk-php/composer.json`. The `"license": "MIT"` field is already correct.
3. Do NOT touch `packages/sdk-python/` or `packages/sdk-go/`.

**Validation:**
- `diff packages/sdk-php/LICENSE LICENSE` returns no diff.
- `cd packages/sdk-php && composer validate --strict` (if Composer available) emits no new warnings.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.

### 4. `docs(sdk-rust): examples/webhook.rs end-to-end demo`

`packages/sdk-rust/src/webhook.rs` (228 LOC) exports `sign_payload`, `parse_webhook`, `VerifyOptions`, `ParsedWebhook`, `ParseWebhookResult`, `WebhookError`. The crate's `examples/` directory holds only `quickstart.rs` (covering the HTTP client). There is **no runnable example** showing the webhook-signature verification flow that merchants need to wire up first when accepting payments.

Premissa 9 (Webhooks Stripe-grade — signature verification is the canonical reliability primitive) + Premissa 23 (SDK-first DX) + Premissa 25 (DevRel + open SDK).

**Scope (1 new file, ~80-100 LOC):**

1. Create `packages/sdk-rust/examples/webhook.rs`.
2. Header doc-comment mirrors `examples/quickstart.rs` shape (module-level `//!` block with "End-to-end ZettaPay Rust SDK webhook verification" + run instructions + scope statement).
3. Demonstrate three concrete cases:
   - **Sign + verify round-trip** — call `sign_payload(secret, payload, timestamp_ms)`, build `VerifyOptions`, call `parse_webhook(opts)`, assert `result.is_valid()` returns true and `into_result()` returns `Ok(ParsedWebhook { .. })`.
   - **Expired timestamp** — same payload but with a timestamp ≥ 6 minutes in the past, assert `into_result()` returns `Err(WebhookError::Expired)` (or whatever the actual variant is — read the enum at line 99 of `src/webhook.rs`).
   - **Bad signature** — tampered payload, assert `Err(WebhookError::InvalidSignature)`.
4. Use only public exports from the `zettapay` crate — no internal modules.
5. Provide a `main()` that runs all three cases and prints `✓` / `✗` lines so the example is `cargo run --example webhook` friendly.
6. Do NOT modify `src/webhook.rs` — examples only.
7. Do NOT add new dev-dependencies — use only `std::time::{SystemTime, UNIX_EPOCH}` for timestamp generation.

**Validation:**
- `cargo build --example webhook --manifest-path packages/sdk-rust/Cargo.toml` (if Rust toolchain available) compiles cleanly.
- `npm run build` unaffected (Rust files outside TypeScript build).
- Wallet-less hard rule N/A — webhook verification is HMAC, no wallet code.

### 5. `docs(sdk-python): examples/webhook.py end-to-end demo`

`packages/sdk-python/zettapay/webhook.py` exports `parse_webhook`, `ParsedWebhook`, `ParseWebhookResult` and the underlying helpers. The package's `examples/` directory holds only `quickstart.py` (covering the HTTP client). There is **no runnable example** showing the webhook-signature verification flow.

Premissa 9 + Premissa 23 + Premissa 25 (same as Pick #4).

**Scope (1 new file, ~80-100 LOC):**

1. Create `packages/sdk-python/examples/webhook.py`.
2. Header docstring mirrors `examples/quickstart.py` shape (module-level `"""..."""` with "End-to-end ZettaPay Python SDK webhook verification" + run instructions + scope statement).
3. Demonstrate three concrete cases (same trio as Pick #4):
   - Sign + verify round-trip (compute HMAC-SHA256 over `{timestamp}.{payload}` with `hmac` + `hashlib`, build the headers dict matching what `parse_webhook` expects per the source at `packages/sdk-python/zettapay/webhook.py` lines 102+, call `parse_webhook`, assert valid).
   - Expired timestamp (6+ minutes old) — assert `ParseWebhookResult` reports the expected error code via `into_result()` or equivalent.
   - Bad signature (tampered body) — assert error.
4. Use only public exports from the `zettapay` package — `from zettapay import parse_webhook, WebhookError, ParsedWebhook` or whatever names match the `__init__.py` re-export surface (verify against `packages/sdk-python/zettapay/__init__.py` before importing).
5. Provide an `if __name__ == "__main__":` block that runs all three cases and prints `✓` / `✗` lines.
6. Do NOT modify `zettapay/webhook.py` — examples only.
7. Do NOT add new dependencies — `pyproject.toml` declares `dependencies = []` (zero runtime deps) and the example must respect that; use only `hmac`, `hashlib`, `time` from the standard library.

**Validation:**
- `cd packages/sdk-python && python examples/webhook.py` (if Python available) prints three lines and exits 0.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.

---

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not** chosen because they fail one or more of {single-file, single-objective, auto-mergeable, non-controversial, outside chronic-broken lane}:

- **`CHANGELOG.md` at root** — repeatedly rejected (in `2e05f052`, `66b549af`, `9db4cb78`, `bf6837e4`, `d5806497`, `e365137f`, `07b1ae9c`): release-ops decision (manual vs Changesets vs Release Drafter) not yet made.
- **`CODEOWNERS`** — repeatedly rejected (`9db4cb78`, `a82d92db`, `bf6837e4`, `d5806497`, `e365137f`, `07b1ae9c`): per-package ownership map needs a human owner/team decision.
- **`.github/FUNDING.yml`** — repeatedly rejected: which sponsor target (GitHub Sponsors? Open Collective? Crypto address?) is a bikeshed.
- **`CODE_OF_CONDUCT.md`** — repeatedly rejected: Contributor Covenant 2.1 is standard but enforcement contact needs an ops decision.
- **`public/manifest.json` PWA shell** — Premissa 28 mentions "PWA installable" but a manifest without a service worker / offline route is half-shipped; needs a coordinated multi-file mission.
- **`public/favicon.svg` / `favicon.ico`** — needs the brand SVG asset chosen (the existing `Logo_symbol.png` would lose detail at 16x16); design decision.
- **`packages/widget/test/{modal,styles}.test.ts`** — DOM-coupled, need jsdom scaffolding; separate missions once the widget vitest config is proven stable by the already-queued `qr.test.ts` and `api.test.ts` landings.
- **`packages/embed/test/ui.test.ts`** — jsdom-coupled; separate later mission.
- **`packages/sdk-go/examples/webhook.go`** — `packages/sdk-go/src/` webhook verifier is QUEUED in `1986ee3d` but not yet shipped; ship the verifier first, then the example as a separate single-file mission (same template as picks #4/#5).
- **`packages/sdk-php/examples/webhook.php`** — same rationale: sdk-php webhook verifier is queued in `1986ee3d` but not shipped; example follows.
- **`packages/api/*` build break** — chronic compile lane; not auto-merge.
- **`scripts/check-idl-drift.sh`** — would need Anchor toolchain in CI; queued `static-analysis-rust.yml` (from `2e05f052`) is the better forcing function for that surface.
- **Per-SDK CHANGELOG.md** — each SDK's CHANGELOG is its own release-ops decision.
- **Zombie sentinel chains (Z29.4 / Z28.5 / Z30.x / Z19.2)** — orchestrator-side UUID stickiness, not code missions.

---

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"` against this PR's diff returns **only documentary references** (this rationale doc + SQL comments quoting the rule). No code in the proposed missions calls `connect()` or imports wallet-adapter UI.

The five mission targets themselves are also wallet-less by construction:

- `packages/sdk-python/LICENSE` — plain text.
- `packages/sdk-go/LICENSE` — plain text.
- `packages/sdk-php/LICENSE` — plain text.
- `packages/sdk-rust/examples/webhook.rs` — webhook HMAC verification, no wallet code.
- `packages/sdk-python/examples/webhook.py` — same.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`). `npm run build` state on this branch is identical to `main` — the chronic `packages/api` TS1xxx break is unchanged; this PR cannot have introduced or repaired it.

## Zombie sanity

Cross-referenced the last 60 merged PRs (#202..#261) + the open PR list (~50 zombie sentinels + 2 open feat / sentinel PRs) + the rolling sentinel log (worker memory `project_zombie_sentinel_log.md`) + the thirteen prior refill SQL companions. **None of the 5 mission names** in this refill collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. The Supabase MCP is not granted to mission workers (worker memory `feedback_supabase_mcp_unavailable.md`); the SQL companion file `docs/discovery/c08a7f17-backlog-refill.sql` is the canonical payload. **Orchestrator (or human operator with service-role key) applies it on merge.** All five INSERTs are wrapped in a single `BEGIN/COMMIT` so partial application is impossible; the audit-journal INSERT runs after the transaction commits so a partial-failure can still be observed in the journal.
