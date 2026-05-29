# Auto-discovery backlog refill — `291b8665` (17th pass)

**Generated:** 2026-05-29 — workspace `zettapay` (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`).

Five single-file, single-objective, additive picks distinct from the 16 prior
refills (`fba46358` .. `c3f319e1`). This pass is **deliberately not a docs
refill** — the previous seven passes (PRs #258 through #264) were all docs
and reviewer fatigue around concept-doc bikeshedding has been called out by
multiple prior refill authors. The five picks below are weighted toward
**real implementation gaps**: two unauthenticated `/api/internal/*` endpoints
that ship a public open-relay + HMAC-oracle, two acceptance probes for code
paths that decide custody and confirmation policy, and one unit-coverage gap
on the most-public SDK export Z66 just landed.

## Companion SQL

[`docs/discovery/291b8665-backlog-refill.sql`](./291b8665-backlog-refill.sql)
inserts the 5 missions + a single `auto_regen_executed` audit entry.
Supabase MCP is not granted to mission workers
(`feedback_supabase_mcp_unavailable.md`); the orchestrator (or human
operator with the `service_role` key) applies the payload on merge.

## The 5 picks

| # | Mission name (≤60 chars)                                        | Target file(s)                                                              | Theme    | Layer 0       |
|---|------------------------------------------------------------------|------------------------------------------------------------------------------|----------|---------------|
| 1 | `sec(api): bearer-token gate on internal/webhooks/test`          | modify `api/internal/webhooks/test/[invoiceId].ts` + `.env.example` + probe  | Security | 9, 16, 21, 22 |
| 2 | `sec(api): bearer-token gate on internal/listener/status`        | modify `api/internal/listener/status.ts` + probe                             | Security | 16, 21, 22    |
| 3 | `test(api): xpub HR-CUSTODY acceptance probe`                    | new `api/test/acceptance/xpub-rejects-private.ts`                            | Test     | HARD-RULE, 14 |
| 4 | `test(api): BTC confirmation-tier boundary probe`                | new `api/test/acceptance/confirmation-tiers.ts`                              | Test     | 9, 14, 18     |
| 5 | `test(sdk): parseEvent() server export unit coverage`            | new `packages/sdk/test/server/events.test.ts`                                | Test     | 23, 27, 29    |

## Why these and not others

### Picks 1 + 2 — unauthenticated `/api/internal/*` endpoints on the public surface

`vercel.json` routes `api/**/*.ts` as public functions; the `/internal/` path
prefix is naming convention only, not enforcement. Two endpoints in that tree
today are reachable by anyone:

- **`api/internal/webhooks/test/[invoiceId].ts`** accepts a
  `webhook_url_override` + `webhook_secret_override` from any unauthenticated
  POST and, with `body.echo !== true`, posts the request body to the supplied
  URL with the supplied HMAC. This is a textbook open relay (RFC-grade SSRF
  primitive) AND an HMAC-signing oracle. `audit/OWASP_TOP_10.md` flags both
  A05 (Security Misconfiguration) and A10 (SSRF). It is the single highest
  blast-radius unauthenticated endpoint anywhere in the tree right now.
- **`api/internal/listener/status.ts`** returns `subscribed_addresses` (live
  invoice count) + `last_invoice_at` to any anonymous caller. Pre-launch
  competitive-intelligence leak plus an enumeration vector for active address
  watches.

Both picks add a `ZETTAPAY_INTERNAL_TOKEN` bearer-token check using
`node:crypto` `timingSafeEqual` (same constant-time pattern already in
`api/_lib/hmac.ts`). The two PRs are independent — each ships its own inlined
check — so they can be reviewed + reverted in isolation. A future mission can
extract a shared `api/_lib/internal-auth.ts` helper once both have soaked.

### Pick 3 — HR-CUSTODY canary

HR-CUSTODY (CLAUDE.md HARD-RULE block, canonical 2026-05-11) is the single
most important invariant in this codebase: **ZettaPay must never hold a key
that can sign.** `parseMerchantXpub()` in `api/_lib/xpub.ts` is the SOLE
chokepoint that enforces it on the Vercel surface — every BTC invoice
creation flows through it. A regression that quietly accepts an `xprv` (e.g.
a refactor that drops `xprv` from `PRIVATE_VERSIONS`) ships green today: the
only existing coverage is `api/test/acceptance/btc-payment.ts` check #5
`no_custodial`, which grep-scans the REPO for HR-CUSTODY patterns but does
NOT exercise `parseMerchantXpub` directly. Pick 3 closes that hole with a
public probe hitting every private-key variant (xprv, zprv, yprv, tprv,
uprv, vprv) + corrupted-checksum garbage + known-valid mainnet zpub and
testnet tpub.

### Pick 4 — confirmation-tier boundary lock

`requiredConfirmations()` in `api/_lib/btc-confirmations.ts` decides whether
a $499.99 invoice releases at 3 confirmations or 6 — and a $500 invoice the
opposite. Wrong answer maps directly to either reorg risk (under-confirmed
release) or merchant friction (over-confirmed wait). The tier ladder
(`< $50: 1`, `< $500: 3`, `≥ $500: 6` + safety floor for NaN / Infinity /
negative) is documented in CLAUDE.md but has **zero** assertions anywhere
in the test tree. Pick 4 ships a public probe pinning every boundary, every
safety-fallback input, plus a structural assertion on `CONFIRMATION_TIERS`
shape so a refactor that reorders the array fails fast.

### Pick 5 — SDK `parseEvent()` narrowing

Z66 (PR #303, 2026-05-27) added `parseEvent()` + `ZettaPayEventSchema` to
the `@zettapay/sdk` `/server` export surface. It is the canonical narrowing
seam merchants use to type their webhook payloads
(`switch (event.type) { case 'invoice.confirmed': ... }`). Today
`packages/sdk/test/server/` only has `webhook.test.ts` (HMAC verification,
NOT schema parsing). A regression in the schema (broken discriminator,
widened nullability, dropped event type) ships green. Pick 5 covers the
canonical seam including a compile-time exhaustive-switch assertion via
`// @ts-expect-error` so the union contract is enforced by `tsc`, not just
runtime.

## Themes deliberately AVOIDED

Each rejected 2+ times by prior reviewers, or symptomatic of reviewer fatigue:

- **More concept docs** (`docs/concepts/*.mdx`) — last 7 auto-regens (PRs
  #258–264) were all docs refills; reviewer fatigue is real. The earlier
  attempt at THIS UUID (`291b8665`, untracked artifact in the worktree)
  proposed 3 concept docs + 2 surface-shape tests. This pass replaces them
  with the highest-impact production gaps the worker found by reading the
  actual code under `api/internal/*` and `api/_lib/*`.
- **`CHANGELOG.md`** per-package (release-ops decision).
- **`CODEOWNERS`** (owner / team decision).
- **`FUNDING.yml`** (sponsor target bikeshed).
- **`CODE_OF_CONDUCT.md`** (enforcement contact decision).
- **`public/manifest.json`** PWA shell (needs service-worker coordination).
- **`public/favicon.*`** (needs brand-design decision).
- **Aggressive CSP / HSTS / X-Frame-Options** (needs site-wide rollout
  plan; spec mentions middleware but no middleware file exists yet).
- **Per-SDK `examples/webhook.*`** for sdk-go and sdk-php (underlying
  source verifiers still queued in `1986ee3d`; example must follow source).
- **Surface-stability re-export tests** on `packages/listener` and
  `packages/receiver` — useful but lower-impact than the security gaps
  the worker found. Deferred to a future pass when the security backlog
  has drained.

## Notable deferrals (blocked or future-pass)

- **Webhook-test endpoint rate-limit** (Premissa 11) — follow-up to pick 1.
  Defer until the auth gate (pick 1) lands so the rate-limit key is
  meaningful.
- **Shared `api/_lib/internal-auth.ts` helper** — intentionally inlined in
  picks 1 + 2 so each ships independently. Extract once both soak.
- **RLS policies on `zettapay_*` tables** (Premissa 22). Migration
  `20260517000000_z53_xpub_btc_payments.sql` enables RLS but ships no
  policies, relying on service-role bypass. Currently safe (deny-all
  default) but needs `merchant_id = auth.uid()` policies once dashboard
  auth (Z40, PR #269 open) is wired. Defer until Z40 lands.
- **Webhook delivery worker stress test** — `packages/listener` has good
  unit coverage on the dispatcher but no public acceptance probe. Defer.
- **Audit-log row on auth failure** (defense in depth) — follow-up to picks
  1 + 2.

## Premissas Layer 0 alignment

- **Pick 1 + 2:** Premissa 9 (Stripe-grade webhooks), Premissa 16 (mainnet
  gate — open endpoints block launch), Premissa 21 (no secrets in code —
  env var, not committed), Premissa 22 (security middleware spirit).
- **Pick 3:** HARD-RULE wallet-less / HR-CUSTODY (canonical 2026-05-11),
  Premissa 14 (non-custodial).
- **Pick 4:** Premissa 9 (Stripe-grade reliability), Premissa 14 (custody —
  payer→merchant direct, no reorg double-spend tolerated), Premissa 18
  (audit before mainnet).
- **Pick 5:** Premissa 23 (SDK first), Premissa 27 (Quality Gate),
  Premissa 29 (Auto-Merge Squad mechanical).

## Scope discipline

Each mission ships with:

- **Single objective** — no bundled refactors.
- **1 primary file** (picks 3, 4, 5) or 2-3 files (picks 1, 2 with the shared
  `.env.example` + acceptance-probe header propagation).
- **Validation commands inline** — every mission spec lists `grep`/`curl`
  assertions reviewers run to verify.
- **Out-of-scope callouts** — every spec lists what NOT to touch so future
  reviewers don't expect creep.
- **No new runtime dependencies** (zod is already a transitive sdk dep).
- **No changes under `packages/api/`** — that lane is chronically broken
  (`project_build_broken.md`); root `api/**` and `packages/sdk/test/` are
  clean compile lanes.

## Build-lane sanity

This PR is **2 new doc files** under `docs/discovery/` only — no source
edits. `npm run build` state on this branch is identical to `main`; the
chronic `packages/api` TS1xxx break is unchanged.

## Wallet-less hard rule sanity

Forbidden strings (`wallet.connect`, `window.solana.connect`,
`wallet-adapter-react-ui`, `Connect Phantom`, `Connect Wallet`,
`Connect MetaMask`) appear only as documentary references in this
rationale doc + SQL comments. All 5 mission TARGETS are wallet-less by
construction:

- Picks 1 + 2 are server-side bearer-auth on Vercel functions.
- Pick 3 IS the wallet-less enforcement probe (refuses every signing key).
- Pick 4 is pure numeric tier validation.
- Pick 5 is a Zod schema unit test — no wallet code path.

## Zombie sanity

Cross-referenced the last 60 merged PRs (#247..#306) + the open PR list +
worker memory `project_zombie_sentinel_log.md` + the 16 prior refill SQL
companions. None of the 5 mission names collide with prior or in-flight
work. A stale prior attempt for this same UUID (`291b8665`) left two
untracked files in the worktree (a 5-pick set heavy on docs + surface
tests); the worker reviewed those, judged them lower-impact than the
security + HR-CUSTODY gaps surfaced by reading the actual production code,
and overwrote with the picks documented above.

## Test plan

- [x] Two new files only (`docs/discovery/291b8665-backlog-refill.md` + `.sql`); no source edits.
- [x] `npm run build` state identical to `main`.
- [x] Each mission spec scopes a single objective, names exact target path(s), lists distinct-from-prior justification, includes wallet-less hard-rule grep check, and ends with PR title + branch convention.
- [x] SQL `BEGIN/COMMIT` wraps all 5 mission INSERTs; `auto_regen_executed` audit fires from the same transaction after the inserts.
- [ ] Orchestrator applies `docs/discovery/291b8665-backlog-refill.sql` on merge to enqueue 5 missions + 1 audit entry.

Co-authored-by: Veridian Fabric
