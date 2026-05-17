# Auto-discovery backlog refill — 9db4cb78

Seventh auto-discovery pass for workspace **zettapay**
(`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`). Source mission UUID prefix:
`9db4cb78`. Generated 2026-05-17.

## Prior six refills

| PR  | UUID prefix | Theme                                             |
|-----|-------------|---------------------------------------------------|
| #231 | `fba46358` | Single-objective dev miscellany (SDK errors.ts, LOG_PRETTY docs, Immunefi, sdk-python + sdk-rust webhook) |
| #242 | `69cdcbce` | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff |
| #244 | `4f79ec06` | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| #245 | `03cf9a17` | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust + sdk-python CI |
| #251 | `1986ee3d` | SDK parity + supply chain — sdk-go + sdk-php webhook, sdk-php CI, dependabot, embed size budget |
| #252 | `a82d92db` | SDK test + MCP discovery — sdk-go errors+retry test, sdk-python errors test, `.well-known/mcp.json`, `.editorconfig` |

This pass targets the **next-layer** gaps the prior six did not reach:
cross-SDK polyglot parity (Rust inline error test, Go examples dir),
discoverability (sitemap.xml), HARD-rule preventive gating (wallet-less
CI workflow), and root-level contributor onboarding (CONTRIBUTING.md).

## 5 picks (single-objective, single-file, additive)

| # | Mission | Target file | Layer 0 |
|---|---|---|---|
| 1 | `sdk-rust: inline tests for error.rs` | `packages/sdk-rust/src/error.rs` (append `#[cfg(test)] mod tests`) | 23, 29 |
| 2 | `sdk-go: examples/quickstart.go` | `packages/sdk-go/examples/quickstart.go` | 23, 25 |
| 3 | `public/sitemap.xml` | `public/sitemap.xml` + 1-line append to `public/robots.txt` | 24, 25 |
| 4 | `ci: wallet-less HARD rule grep gate` | `.github/workflows/wallet-less-gate.yml` | wallet-less HARD, 31 |
| 5 | `chore: root CONTRIBUTING.md` | `CONTRIBUTING.md` | 25, 31 |

## Why these five

### 1. sdk-rust inline error test (`packages/sdk-rust/src/error.rs`)

Listed explicitly as a **known follow-up** in the `a82d92db` audit payload
("sdk-rust: inline `#[cfg(test)]` for `error.rs` + `retry.rs`"). `retry.rs`
already ships an inline `#[cfg(test)]` block (verified — `grep -l
"#[cfg(test)]" packages/sdk-rust/src/*.rs` returns `client.rs`, `retry.rs`,
`webhook.rs`). `error.rs` is the remaining gap. Scoping to `error.rs` only
keeps the diff single-file and avoids over-bundling with `retry.rs` (already
tested via the existing inline block).

The `is_retryable()` method is `pub(crate)`, so the test **must** be inline
in `error.rs` (not in `tests/`). Premissa 23 (SDK-first multi-language
parity — TS shipped in #234, Go + Python queued in #252) + Premissa 29
(coverage > 70% on critical paths — error classifier is the consumer's
retry decision).

### 2. sdk-go examples (`packages/sdk-go/examples/quickstart.go`)

`packages/sdk-rust/examples/quickstart.rs` and
`packages/sdk-python/examples/quickstart.py` both exist. The Go SDK has
**no `examples/` directory at all** (verified `ls`). First-touch
developers copy the example, so missing examples is a real adoption
friction. Premissa 23 + Premissa 25.

The example uses the same fixture pubkey/ATA as the Rust example so
devs migrating between SDKs see identical output.

### 3. SEO sitemap (`public/sitemap.xml`)

`public/robots.txt` was shipped in #242 (`69cdcbce`). It currently has
no `Sitemap:` directive because the sitemap file doesn't exist
(verified — `ls public/sitemap.xml` returns "No such file or directory").
The site ships 20 HTML pages (14 top-level + 5 /docs/* + the dashboard/
sub-tree). A static sitemap is the lowest-friction discoverability lever
— no build step, no script, no workflow. Premissa 24 (documentation
site critical for adoption) + Premissa 25 (DevRel > paid marketing).

This is also a **two-line append** to robots.txt (`Sitemap:
https://zettapay.dev/sitemap.xml`), so the full mission is still
single-objective.

### 4. Wallet-less CI gate (`.github/workflows/wallet-less-gate.yml`)

The HARD rule in CLAUDE.md ships its own grep command as the
acceptance gate: `grep -r "wallet.connect|window.solana.connect|..."
src/`. Today that runs **manually** in mission self-checks and in PR
review. Making it a CI gate prevents drift on any future PR (including
PRs authored by humans who do not read CLAUDE.md).

Workflow is **dedicated** (not bundled into existing `sdk-go.yml` or
`npm-publish.yml`) so a single failing match does not break unrelated
SDK builds. The scan **excludes** markdown / docs / mission spec files —
those DOCUMENT the rule and must mention the banned strings. Premissa
wallet-less HARD rule + Premissa 31 (build green gate is mandatory).

### 5. Root CONTRIBUTING.md

`packages/sdk-rust/CONTRIBUTING.md` and
`packages/sdk-python/CONTRIBUTING.md` both exist. The repo root has
**none** (verified). GitHub's contributor-discovery UI looks at the
root first; without a root `CONTRIBUTING.md`, external contributors
land on the README and guess across five language ecosystems. Premissa
25 (DevRel + open SDK > paid marketing) + Premissa 31 (open source MIT
— contribution path must be public).

Explicitly defers CODEOWNERS (memory: "needs human owner/team
decision — not shovel-ready").

## Wallet-less HARD rule

Every pick was grepped against the CLAUDE.md banned-string list:

- **#1** `error.rs` — no transport surface; pure error classifier
  logic. Zero matches.
- **#2** `examples/quickstart.go` — uses `BaseURL` + `APIKey` env vars
  and pre-signed base64 blob; no `wallet.connect`. Zero matches.
- **#3** `sitemap.xml` — static XML listing public-page URLs. Vacuous.
- **#4** `wallet-less-gate.yml` — the workflow **defines** the banned
  pattern, so it contains the banned strings as literals. The grep
  gate **excludes `.yml` files** from scanning so the workflow does not
  self-trip. This is intentional and documented in the spec.
- **#5** `CONTRIBUTING.md` — documents the rule and lists the banned
  strings for contributors. The grep gate excludes `.md` from scanning;
  doc does not self-trip.

## Safe lane

- `packages/sdk-rust/src/error.rs` — additive `#[cfg(test)]` block,
  same-package test reaches `pub(crate)` symbols. Gated by `cargo
  test` (the sdk-rust CI workflow is queued in #245).
- `packages/sdk-go/examples/quickstart.go` — runs under the parent
  `packages/sdk-go/go.mod`. Gated by `go build` / `go vet` (sdk-go.yml
  exists).
- `public/sitemap.xml` + `public/robots.txt` append — static asset, no
  compile lane.
- `.github/workflows/wallet-less-gate.yml` — workflow only, no source
  touch.
- `CONTRIBUTING.md` — markdown only, no compile lane.
- **None** touch the chronic-broken `packages/api` compile lane (worker
  memory `project_build_broken.md`).

## SQL companion

`docs/discovery/9db4cb78-backlog-refill.sql` ships:

- 5 × `INSERT INTO fabric_squad_missions` (full detailed prompt body,
  escaped via `$$ … $$`).
- 1 × `INSERT INTO fabric_audit_journal` with `event_type =
  'auto_regen_executed'` and full payload (prior refills, missions
  inserted, themes, safe lanes, avoids, known follow-ups).
- All wrapped in `BEGIN; … COMMIT;` (no partial application possible).

Worker cannot reach Supabase MCP directly (worker memory
`feedback_supabase_mcp_unavailable.md`); orchestrator or a human
operator with the service-role key applies on merge.

## Test plan

- [x] All 5 target files verified missing on `main` (HEAD `6902c9a`) —
      `ls`-checked.
- [x] No open PR conflicts — `gh pr list --state open --limit 60`
      checked; only zombie sentinels + #233 (env doc, unrelated path)
      open.
- [x] SQL is balanced (1 `BEGIN` / `COMMIT`, 6 `INSERT`s, 10 `$$`
      markers = 5 pairs).
- [x] Wallet-less grep — every committed file in this PR passes the
      same grep that the new gate (#4) will enforce, EXCEPT the gate
      file itself + this doc + the SQL companion (all `.md` / `.yml` /
      `.sql`, which the gate excludes).
- [x] Brand discipline — no Claude / Anthropic mentions; no
      revolution / disruption / synergy / game-changer copy.
- [x] Docs only — `git diff --stat` will show exactly two files added:
      `docs/discovery/9db4cb78-backlog-refill.{md,sql}`. Nothing else.
- [ ] Orchestrator applies SQL on merge (post-merge step).

## Known follow-ups (deferred this pass, captured in audit payload)

- `sdk-python: tests/test__http.py` for the transport layer.
- `sdk-python: tests/test_types.py` for the dataclass exports.
- `sdk-rust: integration tests for From<reqwest::Error>` (and
  `url::ParseError`, `serde_json::Error`) — requires fake-transport
  fixtures, not a single-file mission.
- `sdk-go: examples/webhook.go` — separate mission once
  `examples/quickstart.go` lands.
- `CODEOWNERS` — still deferred; needs human owner/team decision.
- `public/manifest.json` PWA shell — still deferred; needs coordinated
  service-worker mission.
- `CHANGELOG.md` per-SDK — each its own mission once a version policy
  is decided.
- `CodeQL` static-analysis workflow — separate mission.
- `license-checker` CI workflow — separate mission.
- `sitemap-index` — only needed when `/docs` grows past 50k URLs (well
  off the critical path).
