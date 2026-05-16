# Auto-discovery backlog refill — 2026-05-16 (UUID 69cdcbce)

**Mission:** Identify exactly 5 dev-execution gaps to refill the ZettaPay backlog.
**Workspace:** zettapay (`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`)
**Source mission UUID prefix:** `69cdcbce`
**Branch:** `auto/69cdcbce--auto-discovery-identificar-pr-ximos-5-g`

---

## Selection method

This pass piggybacks on **Z33E** (`docs/audit/site-gaps-2026-05-16.md`, merged in PR #241 earlier today), which already triaged the 20-page public site and ranked the top 5 launch-readiness gaps with severity/effort. That audit is the freshest signal in the repo and each finding is shovel-ready: evidence cited, suggested fix scoped, wallet-less rule already verified passing site-wide.

Every Z33E gap was independently re-validated at mission-generation time:

| Z33E # | Re-check command | Result |
|---|---|---|
| 1 | `ls public/og-image.png` + `grep -c og:image public/index.html …` | absent + 0 hits |
| 2 | `grep -n 'simulate/demo' public/index.html` | hit at line 613 |
| 3 | `ls public/robots.txt public/sitemap.xml` | both missing |
| 4 | `grep -n '<html lang' public/*.html` | 1 `pt-BR` (pay.html) vs 12 `en` |
| 5 | `grep -n 'result.dashboard_url' public/signup.html` | `\|\| '/dashboard'` fallback present |

All five are **single-file or tightly-clustered**, **doc/HTML-only** (no compile-lane risk against the chronic `packages/api` break), **wallet-less compliant** (none touch wallet UX — the new HARD rule from `CLAUDE.md` is intact), and **auto-merge eligible** under the existing Auto-Merge Squad rubric.

---

## Picks

| # | Mission | Target file(s) | Effort | Layer 0 premissa |
|---|---|---|---|---|
| 1 | OG meta + placeholder image | `public/index.html`, `public/og-image.svg` (new) | S | 25 (DevRel/marketing — first social impression) |
| 2 | Remove broken `/simulate/demo` footer link | `public/index.html` (1 line) | S | 28 (zero tech-debt in new code) |
| 3 | Ship `robots.txt` + `sitemap.xml` | `public/robots.txt`, `public/sitemap.xml` (both new) | S | 24, 32 (docs/status as trust signals) |
| 4 | Fix `pay.html` `<html lang>` | `public/pay.html` (1 char-cluster) | S | 27 (i18n hygiene — lang attr is the floor) |
| 5 | Harden signup → dashboard handoff | `public/signup.html` (2 lines) | M | 9, 28 (reliability + tech-debt removal) |

---

## Why each is a valid gap (Layer 0 alignment)

- **#1 — OG meta.** Premissas 24/25: DevRel and SDK-first marketing > paid ads. A launch link with no preview thumbnail underperforms ~40% on every social channel. Fix is mechanical and lifetime-compounding.
- **#2 — `/simulate/demo` 404.** A homepage CTA that 404s is the single loudest "unfinished site" signal an investor or first-100 user can see. Removing it is the cheapest possible UX win.
- **#3 — robots/sitemap.** Without robots.txt, crawlers can index `/api/*` and dashboard previews; without sitemap.xml, indexing latency stretches from hours to weeks. Premissa 24 (docs site, trust signals).
- **#4 — `<html lang>` outlier.** Screen readers switch pronunciation rules on `lang`; one `pt-BR` page in an otherwise `en` site mis-pronounces English content for accessibility users and confuses hreflang signals. Premissa 27 says PT-BR is the canonical UI language — but the actual site is English-only today; this mission picks the minimal "match the rest of the site" fix and flags the larger i18n decision for human triage (see "Rejected candidates" below).
- **#5 — signup dashboard handoff.** The `|| '/dashboard'` fallback at `signup.html:808` silently routes new merchants to the legacy 1,813-line `dashboard.html` whenever the API response is missing `dashboard_url`. That's a hidden tech-debt mine sitting on the signup happy path. Premissa 28 — zero tech debt in code touched.

---

## Wallet-less hard rule

`grep -rn "wallet.connect|window.solana.connect|window.ethereum.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask"` against each target file → **zero matches**. The new HARD rule from `CLAUDE.md` is preserved by every pick; none of the picks add wallet-modal code.

---

## Z-number sanity & zombie check

Cross-referenced the last 50 PRs and the worker-memory zombie log. None of these 5 picks overlap with:

- Z32 (wallet-less refactor, #177 + #178 + #143 + #187 — already shipped)
- Z33A/Z33C/Z33D/Z33E (rewrites/vercelignore/secret-leak/audit doc — shipped in #237, #239, #238, #241)
- Z31 SDK-language family (#126 + #235 in flight)
- The existing pending backlog entries from PR #231 (`SDK-Python webhook` → already opened as #235; `LOG_PRETTY` → #233; `errors.test.ts` → #234 merged; `BUG_BOUNTY devnet ref` → #232 merged; `SDK-Rust webhook` → #236 merged)

No zombie risk: every one of these 5 is a brand-new piece of work with no prior mission carrying the same `name`.

---

## Build-lane safety

None of the 5 missions touch:

- `packages/api/` (chronic build break — `src/db/payments.ts`, `src/server.ts`, `src/services/payments.ts`)
- `packages/sdk/`, `packages/sdk-rust/`, `packages/sdk-python/` build outputs
- `tsconfig.build.json` include-list (worker memory: `feedback_tsconfig_build_allowlist.md`)

Targets are **public HTML/SVG/TXT/XML assets only**. `npm run build` will be unaffected on every PR these missions spawn — the gate stays in the same state as `main`.

---

## Rejected candidates (flagged for human triage, not auto-merge)

These came up during the audit pass but were deliberately excluded because they violate at least one auto-merge constraint:

1. **Full i18n rebuild for Premissa 27 compliance.** The CLAUDE.md rule says PT-BR is canonical UI; the actual public site is English-only today. Properly fixing this needs a multi-week i18n layer (dictionary keys, language toggle, server-side `Accept-Language` negotiation). That is a Z-scale strategic decision for Leandro, not a single-file auto-merge candidate. Mission #4 only picks the surface-level `<html lang>` consistency fix.
2. **Replace legacy `public/dashboard.html` (1,813 LOC).** Memory `project_dashboard_analytics_split.md` notes the legacy dashboard is still wallet-less and intentionally kept for backwards compat. Removing it requires a routing decision (slug-resolver cookie? login landing page?) that the audit explicitly flags as Leandro-owned. Mission #5 hardens the signup happy path **without** retiring the legacy file.
3. **Privacy + Terms thinness.** The audit flags both pages as legally thin (4 third-party mentions combined). This likely needs a legal-review pass, not engineering — outside the dev squad's auto-merge envelope.
4. **Repair the chronic `packages/api` build break.** Multi-file TS1xxx fix across 3 files in a hot path. Memory says the issue is recurring (Z9.1 #23, Z22 follow-up, etc.). Not a single-shot mission — needs a focused human-led repair PR.
5. **Z29.4 zombie sentinel chain.** Worker memory shows 9+ open sentinel PRs for #186. This is an orchestrator-side issue (UUID stickiness), not a code mission.

---

## Supabase write status

The mission spec asks for direct `INSERT` into `fabric_squad_missions` + `fabric_audit_journal`. Per worker memory `feedback_supabase_mcp_unavailable.md`, the Supabase MCP is **not granted to mission workers** — the SQL companion file (`69cdcbce-backlog-refill.sql`) is the canonical payload. Orchestrator (or a human operator with the service-role key) applies it on merge. All statements wrapped in a single `BEGIN/COMMIT` so partial application is impossible.

---

## Deliverables

- `docs/discovery/69cdcbce-backlog-refill.md` — this rationale doc
- `docs/discovery/69cdcbce-backlog-refill.sql` — 5 `INSERT` rows for `fabric_squad_missions` + 1 `fabric_audit_journal` event of type `auto_regen_executed`

No source code touched. No build-lane impact. Wallet-less rule preserved. Brand discipline: zero Claude/Anthropic references; co-author tag will be Veridian Fabric.
