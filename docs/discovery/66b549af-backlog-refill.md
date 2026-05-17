# Auto-discovery backlog refill — 66b549af

Tenth auto-discovery pass for workspace **zettapay**
(`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`). Source mission UUID prefix:
`66b549af`. Generated 2026-05-17.

## Prior nine refills

| PR   | UUID prefix | Theme                                                                          |
|------|-------------|--------------------------------------------------------------------------------|
| #231 | `fba46358`  | Single-objective dev miscellany (SDK errors.ts tests, LOG_PRETTY, Immunefi, sdk-python + sdk-rust webhook) |
| #242 | `69cdcbce`  | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff  |
| #244 | `4f79ec06`  | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| #245 | `03cf9a17`  | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust + sdk-python CI |
| #251 | `1986ee3d`  | SDK parity + supply chain — sdk-go + sdk-php webhook, sdk-php CI, dependabot, embed size budget |
| #252 | `a82d92db`  | SDK test + MCP discovery — sdk-go errors+retry test, sdk-python errors test, `.well-known/mcp.json`, `.editorconfig` |
| #253 | `9db4cb78`  | Cross-SDK + HARD-rule + onboarding — sdk-rust error inline test, sdk-go quickstart, sitemap.xml, wallet-less CI gate, root CONTRIBUTING.md |
| #254 | `bf6837e4`  | Polyglot SDK + CodeQL + tool-versions — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-python test_types, CodeQL, `.tool-versions` |
| #257 | `d5806497`  | GitHub trust-signal triad + sdk-php hygiene — sdk-php CONTRIBUTING, root SECURITY.md, PR template, ISSUE_TEMPLATE config, sdk-php Exception test |

The prior nine refills drained the polyglot **per-SDK CONTRIBUTING**
(Rust + Python + Go + PHP all queued or shipped), the **per-SDK CI
workflows** (Rust + Python + Go + PHP), the **per-SDK quickstart
example** (Rust + Python shipped, Go + PHP queued), the **root-level
DX collection** (`.editorconfig`, `.nvmrc`, `.tool-versions`, root
CONTRIBUTING.md), the **discovery surface triad** (`security.txt`,
`SECURITY.md`, `sitemap.xml`, `.well-known/mcp.json`), and the
**`.github/` template hygiene** (PR template, ISSUE_TEMPLATE
config.yml, CodeQL, dependabot).

This pass targets the **next-layer gap left by the polyglot SDK push**:
the **three TypeScript npm-published packages** (`@zettapay/sdk`,
`@zettapay/embed`, `@zettapay/widget`) all ship with **incomplete
npm-registry metadata** and the TS SDK has **no per-SDK
CONTRIBUTING.md** — both gaps invisible to the per-SDK Rust/Python/Go/PHP
refills, since those targeted only the non-TS lanes. The pass also
ships a **`.gitattributes`** root file (the last unshipped root-level
config the prior nine passes did not queue).

## 5 picks (single-objective, single-file, additive)

| # | Mission name (≤60 chars)                                            | Target file                                          | LOC est. | Layer 0          |
|---|---------------------------------------------------------------------|------------------------------------------------------|----------|------------------|
| 1 | `npm: @zettapay/sdk add repository/bugs/homepage/keywords`          | `packages/sdk/package.json`                          | ~10      | 23, 25           |
| 2 | `npm: @zettapay/embed add repository/bugs/homepage`                 | `packages/embed/package.json`                        | ~5       | 23, 25           |
| 3 | `npm: @zettapay/widget — strip Phantom name-drop + add npm meta`    | `packages/widget/package.json`                       | ~7       | HARD-rule, 23, 25 |
| 4 | `chore: ship root .gitattributes (EOL + linguist)`                  | `.gitattributes` (new)                               | ~25      | 25, 28           |
| 5 | `sdk-ts: ship packages/sdk/CONTRIBUTING.md (last SDK gap)`          | `packages/sdk/CONTRIBUTING.md` (new)                 | ~90      | 23, 25, 31       |

All five are **pure additive** (no field removals, no compile-path
changes, no source files touched), **single-file**, **single-objective**,
and **outside the chronic `packages/api` build-break lane** (worker
memory `project_build_broken.md`). Pick #3 is the **only one with a
compliance angle** — the existing widget description name-drops
Phantom, which contradicts the wallet-less HARD rule's
"any wallet, not just Phantom" canonical positioning.

## Per-pick rationale

### 1. `npm: @zettapay/sdk add repository/bugs/homepage/keywords`

Verified state on main of `packages/sdk/package.json`:

```
"name": "@zettapay/sdk",
"version": "2.0.0",
"description": "...mainnet-ready...",
"license": "MIT",
"main": ..., "module": ..., "types": ..., "exports": ...,
"files": ["dist", "README.md", "LICENSE"],
"scripts": {...},
"dependencies": {...},
"devDependencies": {...},
"engines": { "node": ">=18.18" },
"publishConfig": { "access": "public" }
```

**Missing:** `repository`, `bugs`, `homepage`, `keywords`. The
other-language SDKs all set the equivalent fields:

- `packages/sdk-rust/Cargo.toml` → `repository`, `homepage`,
  `documentation`, `keywords`, `categories`.
- `packages/sdk-python/pyproject.toml` → `[project.urls]` block with
  Homepage / Repository / Issues + a `keywords` list with six tokens.
- `packages/sdk-php/composer.json` → `homepage` + `keywords` list.

On npmjs.com the `@zettapay/sdk` package page currently shows **no
"Repository" link, no "Issues" link, no "Homepage" link, and no
keyword chips for search discovery**. That is a direct adoption
funnel leak — Premissa 23 (SDK-first canonical) + Premissa 25
(DevRel + open SDK > paid marketing — discoverable npm metadata is
free marketing).

**Anti-scope:** one file. Add exactly four top-level fields between
the existing `license` and `type` keys (or anywhere in the manifest
— npm doesn't care about order). Values:

```json
"keywords": ["zettapay", "solana", "usdc", "payments", "stablecoin", "x402", "sdk"],
"homepage": "https://github.com/leandromaiam-code/zettapay#readme",
"repository": { "type": "git", "url": "git+https://github.com/leandromaiam-code/zettapay.git", "directory": "packages/sdk" },
"bugs": { "url": "https://github.com/leandromaiam-code/zettapay/issues" }
```

Do NOT bump `version`. Do NOT add `author`, `contributors`,
`funding` (each is a separate strategic call). Do NOT change
`description` or `files` array.

### 2. `npm: @zettapay/embed add repository/bugs/homepage`

Verified state on main of `packages/embed/package.json`: has
`keywords` (good), has `engines` + `publishConfig`, but is **missing
`repository`, `bugs`, `homepage`** — same npm-discoverability gap as
pick #1 but with keywords already in place.

**Anti-scope:** one file. Add three fields (mirror the values from
pick #1, but with `"directory": "packages/embed"`). Do NOT touch
`description`, `keywords`, `files`, or any build script.

### 3. `npm: @zettapay/widget — strip Phantom name-drop + add npm meta`

Verified state on main of `packages/widget/package.json`:

```
"description": "ZettaPay drop-in embed widget — single <script> tag
                renders a Pay X USDC button that opens a modal with
                QR + Phantom deeplink + checkout flow."
```

The phrase **"Phantom deeplink"** name-drops a single wallet on the
public npm page. The CANONICAL **wallet-less HARD rule** (CLAUDE.md
HARD RULE block, lines 158-189) is explicit:

> "Customer paga da carteira que quiser (Phantom, Solflare, hardware
> wallet, mobile, exchange)"
> ...
> "O que NUNCA pode aparecer em mission spec ou codigo: Botoes
> 'Connect Wallet', 'Connect Phantom', 'Connect MetaMask'"

The npm description is consumer-facing marketing copy and should
read the same multi-wallet way the landing page does (PR #243
already rewrote the landing hero away from MoonPay + single-wallet
copy; PR #256 repositioned to "P2P confirmation-tracking").
Suggested replacement (no Phantom name-drop, no MoonPay claim):

```
"description": "ZettaPay drop-in widget — single <script> tag renders
                a Pay X USDC button that opens a modal with QR + a
                solana: URI that any Solana wallet can open from
                desktop or mobile."
```

Also missing the same `repository` / `bugs` / `homepage` triad as
picks #1 and #2.

**Anti-scope:** one file. Two changes only — rewrite the
`description` field and add the three URL fields. Do NOT touch
`keywords`, `files`, build script, or any source.

### 4. `chore: ship root .gitattributes (EOL + linguist)`

Verified: `.gitattributes` does NOT exist at the repo root. The
repo is polyglot (TS, Rust, Python, PHP, Go, SQL, HTML, Anchor) and
GitHub's Linguist defaults are wrong in two visible ways:

- **`dist/` artefacts inflate the JavaScript share** — every SDK
  package has a `dist/` after build; without a `linguist-generated`
  marker the GitHub language bar shows JS as the dominant language
  even though Rust + on-chain Anchor code is a larger source surface.
- **`docs/` markdown counts as a code language** — the discovery
  refills + audit docs are doc-only but Linguist treats them as
  Markdown source unless marked `linguist-documentation`.

EOL hygiene is the secondary win: shell scripts under
`scripts/` + the Anchor `programs/*/Cargo.toml` Cargo workspace
need `eol=lf` regardless of the contributor's platform. Without a
`.gitattributes`, Windows contributors silently introduce CRLF
diffs.

Premissa 25 (DX — clean repo language bar is part of first-touch
DevRel) + Premissa 28 (zero @ts-nocheck in new code — the same
hygiene mindset).

**Anti-scope:** one new file at the repo root, ~20-30 lines.
Contents pattern (full list to author in the mission, not here):

```
# Default — auto-detect EOL on commit, normalize to LF in repo
* text=auto eol=lf

# Binary files — never modify
*.png  binary
*.jpg  binary
*.ico  binary
*.pdf  binary
*.woff2 binary

# Generated / vendored — exclude from GitHub language stats
packages/*/dist/**  linguist-generated=true
packages/sdk-rust/target/**  linguist-generated=true
packages/sdk-php/vendor/**  linguist-vendored=true

# Docs — exclude from language bar
docs/**  linguist-documentation=true
audit/**  linguist-documentation=true
*.md  linguist-documentation=true
```

Do NOT add `merge=` strategies, `diff=` filters, or `lockable`
hints — those are advanced and each warrants its own scoped
mission. Plain text + binary + linguist hints only.

### 5. `sdk-ts: ship packages/sdk/CONTRIBUTING.md (last SDK gap)`

Verified state on main:

```
packages/sdk-rust/CONTRIBUTING.md    exists
packages/sdk-python/CONTRIBUTING.md  exists
packages/sdk-go/CONTRIBUTING.md      queued (PR #254 / bf6837e4)
packages/sdk-php/CONTRIBUTING.md     queued (PR #257 / d5806497)
packages/sdk/CONTRIBUTING.md         MISSING — TS, the CANONICAL SDK
```

The TypeScript SDK is the **canonical reference** per Premissa 23
("SDK first. @zettapay/sdk em TypeScript canonical. Outras langs
Z16."), yet it is the **only SDK without a per-SDK CONTRIBUTING.md**.
The four prior refills targeted the non-TS lanes (Rust + Python +
Go + PHP) and skipped TS — natural blind spot since the TS package
sits at `packages/sdk/` rather than `packages/sdk-ts/`. The root
CONTRIBUTING.md (queued in PR #253 / `9db4cb78`) covers monorepo
policy but does not cover TS-specific toolchain hints (vitest, tsc
flags, axios mock pattern in `test/`, the `@noble/curves` +
`@scure/bip32` cryptographic-deps caution, the `dist` build
artefact policy, the `engines.node >= 18.18` floor).

Premissa 23 (TS SDK is canonical) + Premissa 25 (DevRel) +
Premissa 31 (open source SDKs MIT — contribution path must be
public for every SDK without exception).

**Anti-scope:** one new file at `packages/sdk/CONTRIBUTING.md`.
Mirror the section order from `packages/sdk-rust/CONTRIBUTING.md`:

- **What we accept** table (mirror the Rust SDK's table — adapted
  to TS: "would Python/Rust SDK do this?" inverted).
- **Dep policy** — current deps justified line-by-line
  (`@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`,
  `@solana/spl-token`, `@solana/web3.js`, `axios`, `qrcode`). PRs
  adding a runtime dep need maintainer +1 first.
- **Node floor** — `engines.node >= 18.18`. Bumps require a
  separate PR.
- **Local setup** — `npm install --include=dev`, `npm run build`,
  `npm test`, `npm run typecheck`. (Worker memory
  `feedback_npm_install.md` documents the
  `--include=dev` requirement; surface it here so external
  contributors do not hit the silent-skip footgun.)
- **Code style** — TS strict (already enforced by
  `tsconfig.json`). No ESLint config present yet (out of scope
  to add).
- **PR checklist** — same wallet-less HARD-rule check,
  brand-discipline (no Claude / Anthropic / OpenAI), Co-author
  Veridian Fabric items as Rust/Python.
- **License** — MIT, one line.

Do NOT modify `packages/sdk/package.json`, `tsconfig.json`,
`vitest.config.ts`, or any source file. Do NOT add an ESLint
config or a Prettier config — those are independent strategic
calls.

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not**
chosen because they fail one or more of {single-file,
single-objective, auto-mergeable, non-controversial, outside
chronic-broken lane, fresh vs. prior refills}:

- **`packages/sdk/examples/quickstart.ts`** — would be a useful
  parity gap (Rust + Python ship examples, TS does not), but the
  TS quickstart needs to either bundle `@solana/web3.js` (heavy
  dep example file) or stub it (which makes the example
  non-runnable). Each option is a separate design call. Defer.
- **`packages/embed/CONTRIBUTING.md` and `packages/widget/CONTRIBUTING.md`** —
  both packages are TS and could mirror pick #5. But `embed` +
  `widget` are very small surfaces (a single `dist/embed.js`
  output, a single `<script>` widget) and the root CONTRIBUTING +
  the TS-SDK CONTRIBUTING from pick #5 cover the relevant policy.
  Per-package CONTRIBUTING for each TS sub-package is bikeshed.
- **`packages/sdk-rust/examples/README.md`** — parity gap (Python
  examples has README, Rust does not). True but very small win,
  and Rust's `quickstart.rs` has a comment header that already
  documents env vars. Defer.
- **`packages/sdk/package.json` add `author` / `contributors` /
  `funding`** — each is a strategic call (who is "the" author?
  Funding URL needs an ops decision). Not auto-merge.
- **`packages/api/package.json` metadata audit** — `packages/api`
  is the chronic-broken compile lane (worker memory
  `project_build_broken.md`); metadata edits there risk dragging
  the broken compile into review. Stay out.
- **Root `CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1 is
  standard but enforcement contact needs ops decision (rejected
  in PR #257 / `d5806497` rationale too).
- **Root `CHANGELOG.md`** — release-ops decision (rejected in
  prior refills).
- **`CODEOWNERS`** — needs per-package ownership map; ops
  decision.
- **`.github/FUNDING.yml`** — bikeshed (which sponsor target).
- **`.github/ISSUE_TEMPLATE/bug_report.yml` / `feature_request.yml`** —
  form-field design is non-trivial (rejected in PR #257
  rationale).
- **`packages/sdk-php/.phpcs.xml.dist` / `.php-cs-fixer.php`** —
  PHP code-style tooling config; bikeshed (rejected implicitly
  in PR #254 + #257 anti-scope).
- **`packages/sdk/.gitignore`** — Node's stock `.gitignore`
  pattern (`node_modules/`, `dist/`) is handled by the repo
  root `.gitignore`. Per-package `.gitignore` is duplication.
- **`packages/embed/scripts/build.mjs` esbuild minify audit** —
  performance angle (Premissa 17 — bundle <200kb), but the
  `embed` budget gate is already queued in PR #251.
- **`@zettapay/sdk` README badge row** — README change is
  multi-line + design call (which badges: npm version, npm
  downloads, license, CI, bundle size). Defer to a single
  badge-row mission per package.
- **Zombie sentinel chains** — orchestrator-side, not code
  missions.

## Wallet-less hard-rule sanity

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"`
against the diff this PR introduces returns **only documentary
references** (this rationale doc + SQL companion comments
referencing the HARD rule). The five queued missions themselves
are:

- `package.json` npm metadata edit (pick #1) — pure JSON fields,
  no code, no wallet path.
- `package.json` npm metadata edit (pick #2) — same.
- `package.json` description rewrite + metadata (pick #3) — the
  rewrite **REMOVES** the existing Phantom name-drop; the new
  description text suggested above contains zero banned strings.
  Net direction: this pick **improves** the wallet-less posture
  rather than risks it.
- `.gitattributes` (pick #4) — Git config, no code, no wallet path.
- `CONTRIBUTING.md` (pick #5) — Markdown documentation. The
  wallet-less HARD rule is mentioned in the PR-checklist section
  as a contributor reminder (allowed: the queued wallet-less CI
  gate from PR #253 excludes `.md` files from scanning).

None call `connect()` or import wallet-adapter UI.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`).
`npm run build` state on this branch is identical to `main` — the
chronic `packages/api` TS1xxx break (worker memory
`project_build_broken.md`) is unchanged; this PR cannot introduce
or repair it.

## Zombie sanity

Cross-referenced the last 50 merged PRs (#194..#257) + the rolling
sentinel log (worker memory `project_zombie_sentinel_log.md`) +
the nine prior refill SQL companions (`fba46358`, `69cdcbce`,
`4f79ec06`, `03cf9a17`, `1986ee3d`, `a82d92db`, `9db4cb78`,
`bf6837e4`, `d5806497`). **None of the 5 mission names** in this
refill collide with prior or in-flight work.

## Supabase write status

The mission spec asks for direct `INSERT` into
`fabric_squad_missions` + `fabric_audit_journal`. The Supabase
MCP is not granted to mission workers (worker memory
`feedback_supabase_mcp_unavailable.md`); the SQL companion file
`docs/discovery/66b549af-backlog-refill.sql` is the canonical
payload. **Orchestrator (or human operator with service-role
key) applies it on merge.** All statements are wrapped in a
single `BEGIN/COMMIT` so partial application is impossible.
