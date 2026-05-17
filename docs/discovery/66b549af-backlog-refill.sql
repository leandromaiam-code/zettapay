-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 66b549af
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/66b549af-backlog-refill.md
-- Tenth refill pass. All 5 picks are single-file, single-objective,
-- additive, and outside the chronic-broken packages/api compile lane.
-- None introduce wallet-connect code; pick #3 REMOVES an existing
-- Phantom name-drop from the @zettapay/widget npm description, which
-- improves wallet-less posture.
--
-- Themes covered: TypeScript-lane npm-registry metadata parity (sdk +
-- embed + widget all missing repository/bugs/homepage), wallet-less
-- canon enforcement on the public npm description for @zettapay/widget,
-- root .gitattributes (EOL + GitHub Linguist hygiene), and the last
-- per-SDK CONTRIBUTING.md gap (the TypeScript canonical SDK).
--
-- Prior nine refills (drained):
--   #231 fba46358 — SDK errors.ts, LOG_PRETTY, Immunefi, sdk-py+rust webhook
--   #242 69cdcbce — OG meta, robots.txt, footer, html lang, signup handoff
--   #244 4f79ec06 — SDK re-exports, Vercel CORS, /api/pay rate-limit headers
--   #245 03cf9a17 — client.ts vitest, .nvmrc, security.txt, sdk-rust+py CI
--   #251 1986ee3d — sdk-go+php webhook, sdk-php CI, dependabot, embed budget
--   #252 a82d92db — sdk-go errors+retry test, sdk-py errors, mcp.json, editorconfig
--   #253 9db4cb78 — sdk-rust error inline test, sdk-go quickstart, sitemap, wallet-less gate, root CONTRIBUTING
--   #254 bf6837e4 — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-py types test, CodeQL, tool-versions
--   #257 d5806497 — sdk-php CONTRIBUTING, root SECURITY.md, PR template, ISSUE_TEMPLATE config, sdk-php Exception test
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. @zettapay/sdk package.json — add npm-registry metadata
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'npm: @zettapay/sdk add repository/bugs/homepage/keywords',
$$Add the missing npm-registry metadata to `packages/sdk/package.json`. The canonical TypeScript SDK currently ships without `repository`, `bugs`, `homepage`, and `keywords` fields — on npmjs.com the package page has no Repository link, no Issues link, no Homepage link, and no keyword chips for search discovery. Every other-language SDK already publishes the equivalent metadata (Rust Cargo.toml, Python pyproject.toml, PHP composer.json — verified on main).

This is a direct adoption funnel leak. Premissa 23 (SDK-first canonical — TS is THE reference SDK) + Premissa 25 (DevRel + open SDK > paid marketing; discoverable npm metadata is free distribution).

Scope (1 file edit, ~10 LOC added):

1. Edit `packages/sdk/package.json` ONLY. No other files.
2. Add exactly these four top-level fields (placement anywhere in the manifest — npm does not enforce order; recommended placement between `license` and `type` for readability):

   "keywords": ["zettapay", "solana", "usdc", "payments", "stablecoin", "x402", "sdk"],
   "homepage": "https://github.com/leandromaiam-code/zettapay#readme",
   "repository": {
     "type": "git",
     "url": "git+https://github.com/leandromaiam-code/zettapay.git",
     "directory": "packages/sdk"
   },
   "bugs": {
     "url": "https://github.com/leandromaiam-code/zettapay/issues"
   }

3. Do NOT bump `version`. Do NOT add `author`, `contributors`, `funding` (each is a separate strategic call). Do NOT change `description`, `files`, `exports`, `dependencies`, `devDependencies`, `scripts`, or `engines`.
4. The `"directory": "packages/sdk"` sub-key inside `repository` is canonical for monorepo packages and powers the GitHub "Used by" + "Browse code" deep-link from the npm page directly into the sub-package.

Validation:
- `node -e "const p = require('./packages/sdk/package.json'); console.log(p.keywords.length, p.repository.directory, p.bugs.url, p.homepage)"` prints `7 packages/sdk https://github.com/leandromaiam-code/zettapay/issues https://github.com/leandromaiam-code/zettapay#readme`.
- `cd packages/sdk && npm pkg get keywords repository bugs homepage` exits 0 with all four populated.
- `npm run build` (from repo root or `packages/sdk/`) unaffected — metadata-only.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-npm-metadata`. Open PR titled `chore(sdk): add npm-registry repository/bugs/homepage/keywords metadata`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. @zettapay/embed package.json — add repository/bugs/homepage
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'npm: @zettapay/embed add repository/bugs/homepage',
$$Add the missing `repository`, `bugs`, and `homepage` npm-registry metadata to `packages/embed/package.json`. The embed package already declares a `keywords` array, but the three GitHub-link fields are absent — npm page shows no Repository / Issues / Homepage navigation, same gap as pick #1 covers for `@zettapay/sdk`.

Premissa 23 (SDK-first canonical) + Premissa 25 (DevRel + free distribution via discoverable metadata).

Scope (1 file edit, ~5-7 LOC added):

1. Edit `packages/embed/package.json` ONLY. No other files.
2. Add exactly these three top-level fields:

   "homepage": "https://github.com/leandromaiam-code/zettapay#readme",
   "repository": {
     "type": "git",
     "url": "git+https://github.com/leandromaiam-code/zettapay.git",
     "directory": "packages/embed"
   },
   "bugs": {
     "url": "https://github.com/leandromaiam-code/zettapay/issues"
   }

3. Do NOT bump `version`. Do NOT touch `description`, `keywords` (already present), `files`, `exports`, `scripts`, `devDependencies`, or `engines`.
4. Use `"directory": "packages/embed"` for the GitHub deep-link to resolve correctly from the npm page.

Validation:
- `node -e "const p = require('./packages/embed/package.json'); console.log(p.repository.directory, p.bugs.url, p.homepage)"` prints `packages/embed https://github.com/leandromaiam-code/zettapay/issues https://github.com/leandromaiam-code/zettapay#readme`.
- `cd packages/embed && npm pkg get repository bugs homepage` exits 0 with all three populated.
- `npm run build` unaffected — metadata-only.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-npm-metadata`. Open PR titled `chore(embed): add npm-registry repository/bugs/homepage metadata`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. @zettapay/widget package.json — strip Phantom name-drop + add npm meta
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'npm: @zettapay/widget — strip Phantom name-drop + add npm meta',
$$Two coupled edits to `packages/widget/package.json`, both in the same file, both compliance-driven.

(a) The current `description` field on main reads:

  "ZettaPay drop-in embed widget — single <script> tag renders a Pay X USDC button that opens a modal with QR + Phantom deeplink + checkout flow."

The phrase "Phantom deeplink" name-drops a single wallet on the public npm page. The CANONICAL wallet-less HARD rule (CLAUDE.md HARD RULE block) is explicit that customers "paga da carteira que quiser (Phantom, Solflare, hardware wallet, mobile, exchange)" and that single-wallet name-drops in product copy are out of scope. PR #243 already rewrote the landing hero away from MoonPay + single-wallet copy; PR #256 repositioned to "P2P confirmation-tracking". This npm description is the last public surface still naming Phantom in a singular-wallet way.

Replacement description (no Phantom name-drop, no MoonPay claim, accurate to the wallet-less canon):

  "ZettaPay drop-in widget — single <script> tag renders a Pay X USDC button that opens a modal with QR + a solana: URI that any Solana wallet can open from desktop or mobile."

(b) The same file is missing `repository`, `bugs`, `homepage` fields (same gap covered for `@zettapay/sdk` in pick #1 and `@zettapay/embed` in pick #2).

Premissa 23 (SDK-first canonical) + Premissa 25 (DevRel) + the wallet-less HARD rule (CLAUDE.md, takes precedence over any conflicting Layer 0 numbered rule).

Scope (1 file edit, ~6-8 LOC added/changed):

1. Edit `packages/widget/package.json` ONLY. No other files.
2. Rewrite the `description` field exactly per the replacement string above (or close paraphrase — the hard constraint is ZERO mentions of "Phantom" and ZERO "Connect Wallet" / banned-string fragments).
3. Add these three top-level fields:

   "homepage": "https://github.com/leandromaiam-code/zettapay#readme",
   "repository": {
     "type": "git",
     "url": "git+https://github.com/leandromaiam-code/zettapay.git",
     "directory": "packages/widget"
   },
   "bugs": {
     "url": "https://github.com/leandromaiam-code/zettapay/issues"
   }

4. Do NOT bump `version`. Do NOT touch `keywords` (already present), `files`, `exports`, `scripts`, `devDependencies`, or `engines`.
5. Do NOT edit `packages/widget/README.md` — that is a separate doc-audit mission.

Validation:
- `node -e "const p = require('./packages/widget/package.json'); if (/Phantom/.test(p.description)) process.exit(1); console.log(p.repository.directory)"` prints `packages/widget` and exits 0.
- `grep -i 'Phantom\|Connect Wallet\|wallet.connect\|window.solana.connect' packages/widget/package.json` returns NOTHING.
- `cd packages/widget && npm pkg get description repository bugs homepage` exits 0 with all four populated.
- `npm run build` unaffected — metadata-only.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-walletless-description`. Open PR titled `chore(widget): wallet-less description + npm-registry metadata`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. .gitattributes at repo root — EOL + GitHub Linguist hygiene
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: ship root .gitattributes (EOL + linguist)',
$$Create `.gitattributes` at the repo root. The file does not exist on main; the repo is polyglot (TypeScript, Rust, Python, PHP, Go, SQL, HTML, Anchor) and GitHub Linguist's defaults are wrong in two visible ways:

- `packages/*/dist/**` artefacts inflate the JavaScript share of the GitHub language bar after every SDK build, drowning out Rust + on-chain Anchor source.
- `docs/**` + `audit/**` Markdown counts as a source language, inflating the Markdown share.

Secondary win: EOL hygiene. Without `.gitattributes`, Windows contributors silently introduce CRLF diffs in shell scripts under `scripts/` and in the Cargo workspace files. Premissa 25 (DX — clean repo language bar is first-touch DevRel signal) + Premissa 28 (zero @ts-nocheck in new code — same hygiene mindset).

Scope (1 new file at the repo root, ~25-35 LOC):

1. Create `.gitattributes` at the repo root (NOT inside `.github/`).
2. File contents (use this as the canonical template; preserve the section comments):

   # Default — auto-detect text on commit, normalize to LF in repo
   * text=auto eol=lf

   # Binary assets — never touch
   *.png       binary
   *.jpg       binary
   *.jpeg      binary
   *.gif       binary
   *.ico       binary
   *.pdf       binary
   *.woff2     binary
   *.woff      binary
   *.ttf       binary
   *.otf       binary

   # Shell + Cargo + Go must be LF regardless of platform
   *.sh        text eol=lf
   Cargo.toml  text eol=lf
   go.mod      text eol=lf
   go.sum      text eol=lf

   # Generated / vendored — exclude from GitHub Linguist language bar
   packages/*/dist/**            linguist-generated=true
   packages/sdk-rust/target/**   linguist-generated=true
   packages/sdk-php/vendor/**    linguist-vendored=true
   packages/sdk/dist/**          linguist-generated=true
   packages/embed/dist/**        linguist-generated=true
   packages/widget/dist/**       linguist-generated=true

   # Docs — exclude from language bar
   docs/**     linguist-documentation=true
   audit/**    linguist-documentation=true
   *.md        linguist-documentation=true

3. Do NOT add `merge=` strategies, `diff=` filters, or `lockable` hints — those are advanced and each warrants its own scoped mission.
4. Do NOT touch any other file. Do NOT run `git add --renormalize .` in this PR — that triggers a mass-rewrite diff that defeats the auto-merge gate. The repo can normalize incrementally on future commits.

Validation:
- `ls .gitattributes` exits 0 at the repo root.
- `wc -l .gitattributes` returns >= 15 and <= 60.
- `grep -c 'linguist-generated' .gitattributes` returns >= 3.
- `grep -c 'linguist-documentation' .gitattributes` returns >= 2.
- `grep -c 'binary' .gitattributes` returns >= 5.
- `npm run build` unaffected (Git config file, no compile).
- The diff in the PR shows EXACTLY ONE new file added; no other files renormalized or modified.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-gitattributes`. Open PR titled `chore: ship root .gitattributes (EOL + GitHub Linguist hygiene)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. packages/sdk/CONTRIBUTING.md — last per-SDK CONTRIBUTING gap
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-ts: ship packages/sdk/CONTRIBUTING.md (last SDK gap)',
$$Create `packages/sdk/CONTRIBUTING.md` mirroring the structure of `packages/sdk-rust/CONTRIBUTING.md` and `packages/sdk-python/CONTRIBUTING.md`. The TypeScript SDK is the CANONICAL reference per Premissa 23 ("SDK first. @zettapay/sdk em TypeScript canonical"), yet it is the only SDK without a per-SDK CONTRIBUTING.md. Verified on main:

  packages/sdk-rust/CONTRIBUTING.md    exists
  packages/sdk-python/CONTRIBUTING.md  exists
  packages/sdk-go/CONTRIBUTING.md      queued (PR #254 / bf6837e4)
  packages/sdk-php/CONTRIBUTING.md     queued (PR #257 / d5806497)
  packages/sdk/CONTRIBUTING.md         MISSING — canonical SDK gap

The four prior per-SDK CONTRIBUTING refills targeted the non-TS lanes (Rust + Python + Go + PHP) — a blind spot since the TS package lives at `packages/sdk/` rather than `packages/sdk-ts/`. The root CONTRIBUTING.md queued in PR #253 covers monorepo policy but does not document TS-specific toolchain (vitest, the `test/` axios mock pattern, the `@noble/curves` + `@scure/bip32` cryptographic-deps caution, the `engines.node >= 18.18` floor, the `npm install --include=dev` footgun documented in worker memory `feedback_npm_install.md`).

Premissa 23 (TS SDK is canonical) + Premissa 25 (DevRel + open SDK > paid marketing) + Premissa 31 (open source SDKs MIT — contribution path must be public for every SDK).

Scope (1 new file, ~70-110 LOC):

1. Create `packages/sdk/CONTRIBUTING.md` at the SDK root.
2. Mirror the section order from `packages/sdk-rust/CONTRIBUTING.md`:
   - One-paragraph intro pointing back to the root CONTRIBUTING.md (queued in PR #253 / 9db4cb78) for monorepo-wide policy.
   - **What we accept** — table with two columns ("Welcome" vs "Not in scope"). Adapt the Rust table: new endpoints that already exist on the API are welcome; signing / wallet management are out of scope (wallet-less HARD rule); custom retry schemes beyond what `client.ts` exposes are out of scope.
   - **Dep policy** — line-by-line justification for each runtime dep in `packages/sdk/package.json`: `@noble/curves`, `@noble/hashes`, `@scure/base`, `@scure/bip32`, `@solana/spl-token`, `@solana/web3.js`, `axios`, `qrcode`. Adding a runtime dep needs a maintainer +1 in the issue first.
   - **Node floor** — `engines.node >= 18.18`. Bumps require a separate PR with rationale.
   - **Local setup** — `npm install --include=dev` (CALL OUT THE `--include=dev` FLAG — without it, devDependencies silently skip when `NODE_ENV=production` is set by the runner, per worker memory `feedback_npm_install.md`). Then `npm run build`, `npm test`, `npm run typecheck`.
   - **Code style** — TS strict mode (already enforced by `tsconfig.json`). Note that no ESLint config is present yet — out of scope to add in a CONTRIBUTING update.
   - **Test conventions** — the `test/` directory uses vitest + axios mocks; describe the canonical mock pattern (one-paragraph).
   - **PR checklist** — wallet-less HARD-rule grep check (against `src/`), brand discipline (no Claude / Anthropic / OpenAI mentions in commit, PR body, or comments), `Co-Authored-By: Veridian Fabric` trailer.
   - **License** — MIT, one line.
3. Do NOT modify `packages/sdk/package.json`, `tsconfig.json`, `vitest.config.ts`, or any source/test file.
4. Do NOT add an ESLint config, a Prettier config, or a `.editorconfig` (the polyglot `.editorconfig` was queued in PR #252 / a82d92db).

Validation:
- `ls packages/sdk/CONTRIBUTING.md` exits 0.
- `wc -l packages/sdk/CONTRIBUTING.md` returns >= 40 and <= 150.
- `grep -c '^## ' packages/sdk/CONTRIBUTING.md` returns >= 5 (What we accept, Dep policy, Local setup, Test conventions, PR checklist).
- `grep -c 'include=dev' packages/sdk/CONTRIBUTING.md` returns >= 1 (the install footgun must be surfaced).
- `grep -c 'wallet-less\|wallet.connect\|HARD rule' packages/sdk/CONTRIBUTING.md` returns >= 1 (wallet-less rule must be in the PR checklist).
- `grep -c 'Veridian Fabric' packages/sdk/CONTRIBUTING.md` returns >= 1.
- `npm run build` unaffected (markdown, no compile).
- Brand discipline: no Claude/Anthropic mentions IN PROSE. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-ts-contributing`. Open PR titled `docs(sdk): ship per-SDK CONTRIBUTING.md (TS canonical SDK)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', '66b549af',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/66b549af-backlog-refill.md',
     'companion_sql', 'docs/discovery/66b549af-backlog-refill.sql',
     'pass_number', 10,
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', 'a82d92db'),
       jsonb_build_object('pr', 253, 'uuid_prefix', '9db4cb78'),
       jsonb_build_object('pr', 254, 'uuid_prefix', 'bf6837e4'),
       jsonb_build_object('pr', 257, 'uuid_prefix', 'd5806497')
     ),
     'missions_inserted', jsonb_build_array(
       'npm: @zettapay/sdk add repository/bugs/homepage/keywords',
       'npm: @zettapay/embed add repository/bugs/homepage',
       'npm: @zettapay/widget — strip Phantom name-drop + add npm meta',
       'chore: ship root .gitattributes (EOL + linguist)',
       'sdk-ts: ship packages/sdk/CONTRIBUTING.md (last SDK gap)'
     ),
     'themes', jsonb_build_array(
       'typescript-npm-registry-metadata-parity',
       'wallet-less-canon-on-public-npm-description',
       'github-linguist-+-eol-hygiene',
       'last-per-sdk-contributing-gap-ts-canonical'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk/package.json (metadata-only)',
       'packages/embed/package.json (metadata-only)',
       'packages/widget/package.json (metadata + description)',
       '.gitattributes (git config, non-compile)',
       'packages/sdk/CONTRIBUTING.md (markdown, non-compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'version bumps (no @zettapay/* version field touched)',
       'multi-file refactors',
       'strategic / legal / ops decisions (CODE_OF_CONDUCT, FUNDING, CHANGELOG, CODEOWNERS, author, contributors, funding fields)',
       'ESLint / Prettier / PHP-CS code-style tooling',
       'git renormalize / mass-EOL-rewrite diffs'
     )
   ));

COMMIT;
