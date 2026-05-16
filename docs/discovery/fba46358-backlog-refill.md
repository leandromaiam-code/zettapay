# Auto-discovery — backlog refill (2026-05-16)

**Mission UUID prefix:** `fba46358`
**Workspace:** `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Branch:** `auto/fba46358--auto-discovery-identificar-pr-ximos-5-g`

## Mandate

Layer 0 mandates ongoing AutoDev velocity (premissas 23, 25, 30). The execution
backlog was empty, so this report enumerates **five concrete, single-objective,
auto-mergeable gaps** to refill the queue.

Each gap was validated against:

1. The wallet-less hard rule (no `wallet.connect()`, no `window.solana.connect()`,
   no wallet-adapter-react-ui — see `CLAUDE.md`).
2. The last 50 PRs (`gh pr list --state all --limit 50`) to avoid zombie
   reissues of already-shipped scope.
3. Single-file or single-module scope to satisfy the orchestrator's
   `loop_detected` guardrail.
4. Compile-lane safety: the chronic `packages/api` build break is **not**
   touched by any of these missions.

## Picked gaps

### 1. `@zettapay/sdk-python` — webhook signature verifier

| Field | Value |
| --- | --- |
| File | `packages/sdk-python/zettapay/webhook.py` (new) + `__init__.py` re-export |
| Why | Premissa 23 (SDK-first, multi-lang parity). TS SDK exports `parseWebhook` (HMAC over body + timestamp + event id, see `packages/sdk/src/webhook.ts`). Python merchants currently cannot verify inbound webhooks — they must reimplement HMAC themselves. |
| Scope | Port the four headers (`X-ZettaPay-Signature`, `X-ZettaPay-Timestamp`, `X-ZettaPay-Event-Id`, `X-ZettaPay-Attempt`) and the `parse_webhook` function; mirror the `ParseWebhookResult` union as a typed dataclass. |
| Tests | `packages/sdk-python/tests/test_webhook.py` covering ok/bad-signature/stale-timestamp/missing-header. |
| Conflicts | Z31.3 (#126) shipped only client skeletons; webhook helpers are out of that PR's scope — confirmed by `grep verify packages/sdk-python/zettapay/*.py` returning zero matches. |

### 2. `@zettapay/sdk-rust` — webhook signature verifier

| Field | Value |
| --- | --- |
| File | `packages/sdk-rust/src/webhook.rs` (new) + `lib.rs` export line |
| Why | Same as #1 — Rust parity. |
| Scope | Mirror `parse_webhook` returning `Result<ParsedWebhook, WebhookFailureReason>` with `hmac` + `sha2` crates. |
| Tests | `packages/sdk-rust/tests/webhook.rs` covering the same matrix. |
| Conflicts | None — confirmed by `grep verify packages/sdk-rust/src/*.rs` returning zero matches. |

### 3. `@zettapay/sdk` — unit tests for `errors.ts`

| Field | Value |
| --- | --- |
| File | `packages/sdk/test/errors.test.ts` (new) |
| Why | `errors.ts` (58 LOC) is pure — `ZettaPayError` class + `fromAxiosError` translator — and is the surface every SDK consumer touches on failure. Currently zero direct coverage (`grep ZettaPayError packages/sdk/test/` returns nothing). Adds confidence for the SDK 2.0 line without any new runtime dependency. |
| Scope | ~8 cases: ApiErrorBody happy path, http error without body, network error, timeout (`ECONNABORTED`), passthrough of an existing `ZettaPayError`, `isCode`/`isStatus` helpers. |
| Conflicts | None — no open PR touches `errors.ts` (last edited in #109 / SDK 2.0 refactor). |

### 4. `.env.example` — document `LOG_PRETTY`

| Field | Value |
| --- | --- |
| File | `.env.example` (single insert) |
| Why | `packages/api/src/lib/logger.ts:7` reads `process.env.LOG_PRETTY === "1"` to switch pino into pretty-print mode, but the var is undocumented. New contributors hit cryptic JSON logs locally with no hint about the toggle. Premissa 12 (structured logs) — this is the documented escape hatch. |
| Scope | 2-3 line block under the existing logging section. |
| Conflicts | None — no env-var docs PR open. |

### 5. `audit/BUG_BOUNTY.md` — reference live Immunefi devnet listing

| Field | Value |
| --- | --- |
| File | `audit/BUG_BOUNTY.md` (lines 8-12 + 100-108) |
| Why | Z28.2 (#196, merged 2026-05-15) brought the Immunefi **devnet** listing online with a public submission status log under `audit/immunefi/`. The bounty doc still reads "once Z22.1 cuts the mainnet" as if no listing exists. Premissa 19 ($50k public bounty) — doc must point bounty hunters at the live devnet program now, with mainnet pool as an explicit follow-up. |
| Scope | Replace the "once Z22.1 cuts the mainnet" sentence with a paragraph linking to the devnet submission log; add a row to the change-log table dated 2026-05-15 for the devnet listing. Mainnet activation row stays unset. |
| Conflicts | None — #196 only shipped the submission log file, not bounty doc edits. |

## Out-of-scope but flagged for human triage

- **`packages/api` build is red on `main`.** `src/db/payments.ts`, `src/server.ts`, and `src/services/payments.ts` have TS1xxx syntax errors (verified by `npm run build` in this branch). This is the recurring "chronic build break" lane noted in worker memory. Fixing it cleanly likely needs > 1 file and careful diff review — not a good auto-merge candidate. Flagging here so a human-driven mission can pick it up.
- **Z29.4 mainnet activation (PR #186) has 9+ zombie sentinels.** Indicates orchestrator is mis-reading merge state. Not a code mission; an orchestrator-side fix.

## Z-number map (last 50 PRs, sanity check)

Shipped or open: Z25.4 (#181/#191), Z26.1, Z26.2 (#194), Z26.4 (#183), Z26.5 (#140),
Z27.1, Z27.3 (#123), Z27.4 (#129/#172), Z28.2 (#196), Z28.4 (#184/#203), Z28.5 (#138/#204),
Z29.1 (#117), Z29.4 (#186 open), Z29.5 (#135), Z30.1 (#175), Z30.2 (#176), Z30.3 (#133),
Z30.4 (#189), Z30.5 (#197 open), Z31.3 (#126), Z31.5 (#188), Z32 (#177/#178/#143/#187).

The five picks above do **not** intersect any Z-number above.

## Supabase write attempt

The mission spec asks for direct `INSERT` into `fabric_squad_missions` +
`fabric_audit_journal`. The Supabase MCP server (`mcp__claude_ai_Supabase__*`)
was unavailable in this worker's tool grant (`list_projects` returned a
permission denial). The companion file
`docs/discovery/fba46358-backlog-refill.sql` carries the exact `INSERT`
statements; the orchestrator can apply them via the Fabric-side Supabase
service role after merging this PR.
