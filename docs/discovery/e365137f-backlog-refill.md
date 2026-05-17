# Auto-discovery backlog refill — e365137f

Eleventh auto-discovery pass for workspace **zettapay**
(`c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b`). Source mission UUID prefix:
`e365137f`. Generated 2026-05-17.

## Prior ten refills

| PR   | UUID prefix | Theme                                                                          |
|------|-------------|--------------------------------------------------------------------------------|
| #231 | `fba46358`  | SDK errors.ts tests, LOG_PRETTY, Immunefi, sdk-python + sdk-rust webhook       |
| #242 | `69cdcbce`  | Site launch — OG meta, robots.txt, footer link, `<html lang>`, signup handoff  |
| #244 | `4f79ec06`  | SDK + Vercel API lane — re-exports, CORS, rate-limit headers, endpoint discovery |
| #245 | `03cf9a17`  | Test / CI / DX — client.ts vitest, `.nvmrc`, `security.txt`, sdk-rust + sdk-python CI |
| #251 | `1986ee3d`  | SDK parity + supply chain — sdk-go + sdk-php webhook, sdk-php CI, dependabot, embed budget |
| #252 | `a82d92db`  | SDK test + MCP discovery — sdk-go errors+retry test, sdk-python errors, `.well-known/mcp.json`, `.editorconfig` |
| #253 | `9db4cb78`  | Cross-SDK + HARD-rule + onboarding — sdk-rust inline test, sdk-go quickstart, sitemap.xml, wallet-less gate, root CONTRIBUTING |
| #254 | `bf6837e4`  | Polyglot SDK + CodeQL + tool-versions — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-python test_types, CodeQL, `.tool-versions` |
| #257 | `d5806497`  | GitHub trust-signal triad + sdk-php hygiene — sdk-php CONTRIBUTING, root SECURITY.md, PR template, ISSUE_TEMPLATE config, sdk-php Exception test |
| #258 | `66b549af`  | TS-lane npm-registry metadata parity — `@zettapay/sdk` + `@zettapay/embed` + `@zettapay/widget` repository/bugs/homepage, root `.gitattributes`, `packages/sdk/CONTRIBUTING.md` |

The prior ten refills shipped the **TS-lane npm-registry metadata triad**
(`repository`/`bugs`/`homepage` on all three published TS packages),
the **polyglot per-SDK CONTRIBUTING + CI workflow + errors test + webhook
helper + quickstart matrix** (Rust + Python + Go + PHP), the **root DX
collection** (`.editorconfig`, `.nvmrc`, `.tool-versions`, root
`CONTRIBUTING.md`, `.gitattributes`), the **discovery surface**
(`security.txt`, `SECURITY.md`, `sitemap.xml`, `.well-known/mcp.json`),
and the **`.github/` template hygiene** (PR template, ISSUE_TEMPLATE
config, CodeQL, dependabot).

This pass targets two **discoverability+canon gaps** the prior ten passes
did not address:

- The **wallet-less HARD rule still has four public-surface bleeds left
  on `main`** that contradict the canon. PR #258 mission #3 rewrote the
  `@zettapay/widget` npm `description` (already merged) but explicitly
  scoped out `keywords`, the per-package READMEs, and the root README.
  Verified state on main:
  - `packages/widget/package.json` `keywords` array still contains
    `"phantom"` (position 7 of 10).
  - `packages/widget/README.md` line 4 still reads `"a QR code + Phantom
    deeplink + checkout flow"`.
  - `packages/embed/README.md` line 12 still reads `"Need a full modal +
    Phantom deeplink + hosted checkout? Use @zettapay/widget."`.
  - Root `README.md` has four Phantom name-drops (lines 14, 56, 62, 91)
    that single-out one wallet contrary to "Customer paga da carteira que
    quiser (Phantom, Solflare, hardware wallet, mobile, exchange)".
- The **`packages/sdk-php/composer.json` is missing a `support` block**
  (the Packagist analogue of npm `bugs`+`repository`). Verified state on
  main: composer.json has `homepage` and `keywords` but no `support`
  object — the Packagist project page consequently has no "Report Issues"
  or "Browse Source" link, the same adoption-funnel leak the TS-lane
  metadata triad in PR #258 closed for npm.

## 5 picks (single-objective, single-file, additive)

| # | Mission name (≤60 chars)                                        | Target file                                  | LOC est. | Layer 0                  |
|---|-----------------------------------------------------------------|----------------------------------------------|----------|--------------------------|
| 1 | `widget: strip "phantom" from npm keywords (wallet-less)`       | `packages/widget/package.json`               | ~1       | HARD-rule                |
| 2 | `widget: wallet-less README first paragraph rewrite`            | `packages/widget/README.md`                  | ~2       | HARD-rule, 23, 25        |
| 3 | `embed: wallet-less README cross-ref rewrite`                   | `packages/embed/README.md`                   | ~2       | HARD-rule, 23, 25        |
| 4 | `root README: wallet-less rewrite of 4 Phantom name-drops`      | `README.md`                                  | ~6       | HARD-rule, 25            |
| 5 | `sdk-php: add Packagist support block (issues+source)`          | `packages/sdk-php/composer.json`             | ~5       | 23, 25, 31               |

All five are **pure additive or string-replace edits**, **single-file**,
**single-objective**, **outside the chronic `packages/api` build-break
lane** (worker memory `project_build_broken.md`), and **non-compile**
(every target is JSON metadata or Markdown — none touch source files,
neither `npm run build` nor `cargo build` nor `composer install` is
affected).

## Per-pick rationale

### 1. `widget: strip "phantom" from npm keywords (wallet-less)`

Verified state on main of `packages/widget/package.json`:

```json
"keywords": [
  "zettapay",
  "solana",
  "usdc",
  "checkout",
  "embed",
  "widget",
  "phantom",
  "solana-pay",
  "x402",
  "stablecoin"
]
```

`"phantom"` at position 7 of 10 is a wallet name-drop on the public npm
page. The CANONICAL wallet-less HARD rule (CLAUDE.md HARD RULE block) is
explicit that ZettaPay does not single out one wallet —
**"Customer paga da carteira que quiser (Phantom, Solflare, hardware
wallet, mobile, exchange)"**. PR #258 mission #3 rewrote the widget's npm
`description` field to remove the Phantom name-drop there, but
explicitly scoped out `keywords` (PR #258 mission spec line: "Do NOT
touch `keywords` (already present)"). The keyword is still on the public
package page — npm renders `keywords` as clickable chips and they feed
into npm search results, so the name-drop is doubly visible.

Premissa: wallet-less HARD rule (CLAUDE.md, takes precedence over any
conflicting numbered Layer 0 rule per the "regra de número menor vence"
+ HARD rule override).

**Anti-scope (1 file, 1 line edit):**

1. Edit `packages/widget/package.json` ONLY. No other files.
2. Delete the single `"phantom",` entry from the `keywords` array (and
   delete the trailing comma if the deletion creates a trailing comma).
3. Do NOT add a replacement keyword (avoids bikeshed on which wallets
   to enumerate — the canon is "any wallet", not "all wallets" listed).
4. Do NOT touch `description` (already cleaned in PR #258), any of the
   nine remaining keyword entries, `version`, `files`, `exports`, or any
   build/dev script.

**Validation:**
- `node -e "const k=require('./packages/widget/package.json').keywords; if (k.some(x => /phantom/i.test(x))) process.exit(1); console.log(k.length)"` exits 0 and prints `9`.
- `grep -i 'phantom' packages/widget/package.json` returns NOTHING.
- `cd packages/widget && npm pkg get keywords` shows a 9-element array with no `phantom`.
- `npm run build` unaffected — metadata-only.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-keywords-walletless`. PR title:
`chore(widget): strip "phantom" from npm keywords (wallet-less)`.

### 2. `widget: wallet-less README first paragraph rewrite`

Verified state on main of `packages/widget/README.md` (line 3-5):

```
Drop-in embed widget for ZettaPay. One `<script>` tag renders a **Pay X USDC**
button. On click, a modal opens with a QR code + Phantom deeplink + checkout
flow that settles in seconds on Solana.
```

The phrase "Phantom deeplink" name-drops a single wallet on the public
npm-rendered README. Same canon violation pick #1 fixes for `keywords`
and PR #258 mission #3 fixed for `description` — the `README.md` is the
third public surface (npm renders the README on the package page).

Suggested replacement (no Phantom name-drop, accurate to wallet-less canon):

```
Drop-in embed widget for ZettaPay. One `<script>` tag renders a **Pay X USDC**
button. On click, a modal opens with a QR code + a `solana:` URI that any
Solana wallet can open from desktop or mobile, plus a hosted checkout flow
that settles in seconds on Solana.
```

Premissa: wallet-less HARD rule + Premissa 23 (TS SDK canonical surface)
+ Premissa 25 (DevRel — README is the npm landing page).

**Anti-scope (1 file, 1-3 line edit):**

1. Edit `packages/widget/README.md` ONLY. No other files.
2. Rewrite the line containing "Phantom deeplink" exactly per the
   replacement above (or close paraphrase — the hard constraint is ZERO
   matches for `grep -i 'phantom\|connect wallet\|wallet\.connect'` in
   the file after the edit).
3. Do NOT change any other line in the file — bullet list (Bundle /
   Distribution / Brand / Callbacks / Fees), Drop-in CDN snippet, supported
   `data-*` attributes section, JS API examples, all unchanged.
4. Do NOT add a NEW paragraph explaining wallet-less philosophy — the
   replacement line above is sufficient; deeper philosophy belongs in
   the root `README.md` (pick #4) or the docs site, not in the SDK README.

**Validation:**
- `grep -ic 'phantom' packages/widget/README.md` returns `0`.
- `grep -c 'solana:' packages/widget/README.md` returns `>=1`.
- `wc -l packages/widget/README.md` returns within ±2 of the pre-edit line count (line-count parity sanity check — no accidental section deletion).
- `npm run build` unaffected — markdown.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-readme-walletless`. PR title:
`docs(widget): wallet-less README first paragraph rewrite`.

### 3. `embed: wallet-less README cross-ref rewrite`

Verified state on main of `packages/embed/README.md` (line 12-14):

```
Need a full modal + Phantom deeplink + hosted checkout? Use
`@zettapay/widget`. Use `@zettapay/embed` when you want the smallest
possible payload on the merchant site.
```

The "Phantom deeplink" cross-reference to `@zettapay/widget` name-drops
a single wallet on the public npm README of the sister package. Same
canon violation as pick #2.

Suggested replacement (no Phantom name-drop):

```
Need a full modal with a hosted checkout flow + a `solana:` URI that any
Solana wallet can open? Use `@zettapay/widget`. Use `@zettapay/embed`
when you want the smallest possible payload on the merchant site.
```

**Anti-scope (1 file, 1-2 line edit):**

1. Edit `packages/embed/README.md` ONLY. No other files.
2. Rewrite the cross-reference paragraph exactly per the replacement
   above (or close paraphrase — zero `phantom`/`connect wallet`/
   `wallet.connect` matches after the edit).
3. Do NOT touch any other line in the file.

**Validation:**
- `grep -ic 'phantom' packages/embed/README.md` returns `0`.
- `grep -c '@zettapay/widget' packages/embed/README.md` returns `>=1` (cross-reference preserved).
- `wc -l packages/embed/README.md` within ±2 of pre-edit.
- `npm run build` unaffected.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-readme-walletless`. PR title:
`docs(embed): wallet-less README cross-ref to @zettapay/widget`.

### 4. `root README: wallet-less rewrite of 4 Phantom name-drops`

Verified state on main of `README.md` (4 Phantom name-drops):

- **Line 14:** `# drop-in checkout button + modal + Phantom deeplink + hosted flow`
  (inline comment in the `## Install` snippet)
- **Line 56:** `Receives a Phantom wallet pubkey, creates the merchant's USDC ATA on`
  (in the `### POST /merchants/register` description)
- **Line 62:** `{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<phantom-pubkey>" }`
  (in the JSON request example — `<phantom-pubkey>` placeholder)
- **Line 91:** `- Merchant onboarding via Phantom wallet`
  (in the `## Features` bullet list)

All four single-out Phantom in the most-visible doc in the repo. The
landing page (`public/index.html`) was already wallet-less-aligned by
PR #243 + repositioned by PR #256 ("P2P confirmation-tracking"), and
the dashboard surface (PR #164) is wallet-less. The root `README.md` is
the last surface where the canon and the doc still disagree.

Premissa: wallet-less HARD rule + Premissa 25 (DevRel — README is the
GitHub landing page).

Suggested replacements:

- **Line 14:** `# drop-in checkout button + modal + QR code + hosted flow`
  (or: `# drop-in checkout button + modal + solana: URI any wallet can open + hosted flow`)
- **Line 56:** `Receives a Solana wallet pubkey, creates the merchant's USDC ATA on`
- **Line 62:** `{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<solana-pubkey>" }`
- **Line 91:** `- Merchant onboarding via Solana wallet pubkey` (or `- Merchant onboarding — paste any Solana wallet pubkey, no connect required`)

**Anti-scope (1 file, 4-6 line edits):**

1. Edit `README.md` (the ROOT file, NOT `packages/*/README.md`) ONLY.
2. Replace each of the four Phantom name-drops with a wallet-neutral
   phrasing per the suggestions above (or close paraphrase). Hard
   constraint: `grep -ic 'phantom' README.md` returns `0` after the edit.
3. Do NOT change the rest of the README — badge row, Live deployment
   table, Tech Stack, Setup, the rest of Endpoints, the Features bullet
   that mentions MoonPay (allowed — MoonPay is a fiat onramp not a
   wallet name-drop, and PR #243 + #256 already navigated the MoonPay
   marketing-copy canon), Protocol spec section, etc.
4. Do NOT add an `## Wallet-less philosophy` section — that is a
   strategic call (whether to surface the canon prominently in the root
   README is bikeshed; the canon already lives in `CLAUDE.md` and a
   dedicated docs page is a separate mission).

**Validation:**
- `grep -ic 'phantom' README.md` returns `0`.
- `grep -c 'Café Tatuapé' README.md` returns `>=1` (example unchanged in identity).
- `grep -c 'MoonPay' README.md` returns `>=1` (the fiat-onramp Features bullet preserved).
- `grep -c 'walletAddress' README.md` returns the same count as on main (≥1).
- `wc -l README.md` within ±2 of pre-edit.
- `npm run build` unaffected.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-root-readme-walletless`. PR title:
`docs: wallet-less rewrite of root README (4 Phantom name-drops)`.

### 5. `sdk-php: add Packagist support block (issues+source)`

Verified state on main of `packages/sdk-php/composer.json`:

```json
{
  "name": "zettapay/sdk",
  "description": "...",
  "type": "library",
  "license": "MIT",
  "keywords": ["zettapay", "solana", "usdc", "payments", "stablecoin", "x402", "psr-18"],
  "homepage": "https://github.com/leandromaiam-code/zettapay",
  "require": {...},
  ...
}
```

**Missing:** the `support` object. The Packagist analogue of npm
`bugs`+`repository` (covered for the three TS packages in PR #258) is
the [`support` block per Composer schema](https://getcomposer.org/doc/04-schema.md#support):

```json
"support": {
  "issues": "<URL to issue tracker>",
  "source":  "<URL to browseable source>"
}
```

The Packagist project page at packagist.org renders "Issues" and
"Source" navigation buttons only when the `support` block is populated.
Without it, the Packagist page has only a "Homepage" link and no path
to filing a bug or browsing source — the same adoption-funnel leak the
TS-lane metadata triad in PR #258 closed for npm.

Premissa 23 (SDK-first canonical — all SDKs equal-class on registry
discovery) + Premissa 25 (DevRel — Packagist project metadata is free
distribution) + Premissa 31 (open source SDKs MIT — contribution path
must be public for every SDK).

**Anti-scope (1 file, ~5 LOC added):**

1. Edit `packages/sdk-php/composer.json` ONLY. No other files.
2. Add exactly this top-level field (placement: between `homepage` and
   `require` reads cleanest; Composer does not enforce key order):

   ```json
   "support": {
     "issues": "https://github.com/leandromaiam-code/zettapay/issues",
     "source": "https://github.com/leandromaiam-code/zettapay"
   }
   ```

3. Do NOT touch `name`, `description`, `keywords`, `homepage`,
   `require`, `require-dev`, `autoload`, `autoload-dev`, `config`,
   `minimum-stability`, or any other field.
4. Do NOT add `support.email` or `support.docs` or `support.chat` —
   those each need an ops decision and risk bikeshed.

**Validation:**
- `php -r "echo json_decode(file_get_contents('packages/sdk-php/composer.json'))->support->issues;"` prints `https://github.com/leandromaiam-code/zettapay/issues`.
- `python3 -c "import json; d=json.load(open('packages/sdk-php/composer.json')); print(d['support']['source'])"` prints `https://github.com/leandromaiam-code/zettapay`.
- `composer validate packages/sdk-php/composer.json --no-check-publish --no-check-lock` returns "is valid" (if Composer is on PATH; the existing CI workflow queued in PR #251 will revalidate).
- `npm run build` unaffected (PHP file, no JS compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-support`. PR title:
`chore(sdk-php): add Packagist support block (issues+source)`.

## Rejected candidates (flagged for human triage)

The auto-discovery surfaced these but they are explicitly **not**
chosen for this refill (fail one or more of {single-file,
single-objective, auto-mergeable, non-controversial, outside chronic
lane, fresh vs. prior refills}):

- **`packages/widget/src/modal.ts` Phantom universal-link replacement** —
  source code contains a Phantom-specific deeplink (`phantom.app/ul/browse/`)
  generator and an "Open in Phantom" button. Replacing it with a generic
  `solana:` URI + multi-wallet selector is a real refactor with UX +
  test impact across the modal, the embed wallet detection, and the
  Z27.4 multi-wallet extension PR #172. Out of scope for an auto-merge
  refill; warrants its own scoped wallet-less refactor mission.
- **Per-SDK `LICENSE` files for sdk-rust + sdk-python + sdk-go + sdk-php** —
  parity gap (only the three TS sub-packages have a LICENSE alongside
  their manifest; the polyglot SDKs only declare `license = "MIT"` in
  Cargo.toml / pyproject.toml / composer.json). True gap but four
  separate missions and the polyglot tooling does not require a per-
  package LICENSE file (Cargo, Pip, Composer all accept the metadata
  field alone). Defer.
- **`packages/sdk/examples/quickstart.ts`** — TS-lane parity gap (Rust +
  Python ship examples, TS does not). Same rejection rationale as
  PR #258 — bundling vs. stubbing `@solana/web3.js` is a separate
  design call.
- **`packages/embed/CONTRIBUTING.md` and `packages/widget/CONTRIBUTING.md`** —
  rejected in PR #258 as bikeshed (per-package TS-sub CONTRIBUTING is
  duplication of root CONTRIBUTING + the canonical SDK CONTRIBUTING
  queued in PR #258 mission #5).
- **Root `CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1 standard but
  enforcement-contact ops decision (rejected in #257 + #258 rationale).
- **Root `CHANGELOG.md`** — release-ops decision (rejected in prior
  refills).
- **`CODEOWNERS`** — per-package ownership map needs ops decision.
- **`.github/FUNDING.yml`** — bikeshed.
- **`.github/ISSUE_TEMPLATE/bug_report.yml` + `feature_request.yml`** —
  form-field design is non-trivial (rejected in PR #257 + #258).
- **`packages/sdk-php/.phpcs.xml.dist` / `.php-cs-fixer.php`** — bikeshed
  on PHP code-style rules (rejected in PR #254 + #257 + #258).
- **`packages/api/package.json` metadata audit** — `packages/api` is the
  chronic-broken compile lane (worker memory
  `project_build_broken.md`); stay out.
- **Zombie sentinel chains** — orchestrator-side, not code missions.

## Wallet-less hard-rule sanity

Picks #1, #2, #3, and #4 are themselves **wallet-less HARD-rule
ENFORCEMENT** edits — they REMOVE existing Phantom name-drops from the
public surfaces (`packages/widget/package.json` keywords array,
`packages/widget/README.md`, `packages/embed/README.md`, root
`README.md`). Net direction: this refill **improves** the wallet-less
posture across four public surfaces. None call `connect()` or import
wallet-adapter UI.

Pick #5 is PHP metadata — no wallet path, no JS.

`grep -rn "wallet\.connect\|window\.solana\.connect\|window\.ethereum\.connect\|wallet-adapter-react-ui\|Connect Phantom\|Connect Wallet\|Connect MetaMask"`
against the diff this PR introduces returns **only documentary
references** in this rationale doc + the SQL companion comments that
quote the HARD-rule canon.

## Build-lane sanity

This PR is **doc-only** (2 new files under `docs/discovery/`).
`npm run build` state on this branch is identical to `main` — the
chronic `packages/api` TS1xxx break (worker memory
`project_build_broken.md`) is unchanged; this PR cannot introduce
or repair it.

## Zombie sanity

Cross-referenced the last 50 merged PRs (#208..#258) + the rolling
sentinel log (worker memory `project_zombie_sentinel_log.md`) + the
ten prior refill SQL companions (`fba46358`, `69cdcbce`, `4f79ec06`,
`03cf9a17`, `1986ee3d`, `a82d92db`, `9db4cb78`, `bf6837e4`, `d5806497`,
`66b549af`). **None of the 5 mission names** in this refill collide with
prior or in-flight work. Specifically:

- PR #258 mission #3 ("widget — strip Phantom name-drop + add npm meta")
  scoped to `description` field + adding `repository`/`bugs`/`homepage`;
  it explicitly excluded `keywords` (this refill's pick #1) and the
  README (picks #2-#4).
- PR #257 mission #2 (root `SECURITY.md`) is unrelated to this refill's
  pick #5 (sdk-php `support` block — Packagist project metadata, not a
  security-policy doc).

## Supabase write status

The mission spec asks for direct `INSERT` into
`fabric_squad_missions` + `fabric_audit_journal`. The Supabase MCP is
not granted to mission workers (worker memory
`feedback_supabase_mcp_unavailable.md`); the SQL companion file
`docs/discovery/e365137f-backlog-refill.sql` is the canonical payload.
**Orchestrator (or human operator with service-role key) applies it on
merge.** All statements are wrapped in a single `BEGIN/COMMIT` so
partial application is impossible.
