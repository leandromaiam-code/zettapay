-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: e365137f
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/e365137f-backlog-refill.md
-- Eleventh refill pass. All 5 picks are single-file, single-objective,
-- additive (or surgical string-replace), and outside the chronic-broken
-- packages/api compile lane. Four of the five DIRECTLY ENFORCE the
-- wallet-less HARD rule (CLAUDE.md HARD RULE block) by removing existing
-- Phantom wallet name-drops from public surfaces (widget npm keywords,
-- widget README, embed README, root README). The fifth is a Packagist
-- metadata parity gap for the PHP SDK.
--
-- Themes covered:
--   - wallet-less HARD-rule enforcement on the last four public surfaces
--     where the canon and the doc still disagree
--   - Packagist project metadata parity for sdk-php (analogue of the
--     TS-lane npm metadata triad shipped in PR #258)
--
-- Prior ten refills (drained):
--   #231 fba46358 — SDK errors.ts, LOG_PRETTY, Immunefi, sdk-py+rust webhook
--   #242 69cdcbce — OG meta, robots.txt, footer, html lang, signup handoff
--   #244 4f79ec06 — SDK re-exports, Vercel CORS, /api/pay rate-limit headers
--   #245 03cf9a17 — client.ts vitest, .nvmrc, security.txt, sdk-rust+py CI
--   #251 1986ee3d — sdk-go+php webhook, sdk-php CI, dependabot, embed budget
--   #252 a82d92db — sdk-go errors+retry test, sdk-py errors, mcp.json, editorconfig
--   #253 9db4cb78 — sdk-rust inline test, sdk-go quickstart, sitemap, wallet-less gate, root CONTRIBUTING
--   #254 bf6837e4 — sdk-php quickstart, sdk-go CONTRIBUTING, sdk-py types test, CodeQL, tool-versions
--   #257 d5806497 — sdk-php CONTRIBUTING, root SECURITY.md, PR template, ISSUE_TEMPLATE config, sdk-php Exception test
--   #258 66b549af — TS npm metadata triad (sdk+embed+widget), .gitattributes, packages/sdk/CONTRIBUTING.md
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. @zettapay/widget package.json — strip "phantom" from keywords
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'widget: strip "phantom" from npm keywords (wallet-less)',
$$Strip the single `"phantom"` entry from the `keywords` array in `packages/widget/package.json`. The CANONICAL wallet-less HARD rule (CLAUDE.md HARD RULE block) is explicit that ZettaPay does not single out one wallet — "Customer paga da carteira que quiser (Phantom, Solflare, hardware wallet, mobile, exchange)". The `keywords` field is rendered on the public npmjs.com package page as clickable chips and feeds into npm-search results, so the name-drop is doubly visible.

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

PR #258 mission #3 rewrote the widget's `description` field to remove the "Phantom deeplink" name-drop there, but explicitly scoped out `keywords` ("Do NOT touch `keywords` (already present)"). This mission closes that residual gap.

Premissa: wallet-less HARD rule (CLAUDE.md, takes precedence over any conflicting numbered Layer 0 rule per the "regra de número menor vence" + the HARD-rule canonical-overrides block).

Scope (1 file, 1 line edit):

1. Edit `packages/widget/package.json` ONLY. No other files.
2. Delete the single `"phantom",` entry from the `keywords` array (position 7 of 10).
3. Do NOT add a replacement keyword (avoids bikeshed on which wallets to enumerate — the canon is "any wallet", not "all wallets" listed).
4. Do NOT touch `description` (already cleaned in PR #258), any of the nine remaining keyword entries, `version`, `files`, `exports`, or any build/dev script.

Validation:
- `node -e "const k=require('./packages/widget/package.json').keywords; if (k.some(x => /phantom/i.test(x))) process.exit(1); console.log(k.length)"` exits 0 and prints `9`.
- `grep -i 'phantom' packages/widget/package.json` returns NOTHING.
- `cd packages/widget && npm pkg get keywords` shows a 9-element array with no `phantom`.
- `npm run build` unaffected — metadata-only.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-keywords-walletless`. Open PR titled `chore(widget): strip "phantom" from npm keywords (wallet-less)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. @zettapay/widget README.md — wallet-less first paragraph rewrite
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'widget: wallet-less README first paragraph rewrite',
$$Rewrite the first paragraph of `packages/widget/README.md` to remove the "Phantom deeplink" wallet name-drop. The README is rendered as the npmjs.com package landing page and contradicts the wallet-less HARD rule.

Verified state on main of `packages/widget/README.md` (line 3-5):

```
Drop-in embed widget for ZettaPay. One `<script>` tag renders a **Pay X USDC**
button. On click, a modal opens with a QR code + Phantom deeplink + checkout
flow that settles in seconds on Solana.
```

Replacement (no Phantom name-drop, accurate to wallet-less canon):

```
Drop-in embed widget for ZettaPay. One `<script>` tag renders a **Pay X USDC**
button. On click, a modal opens with a QR code + a `solana:` URI that any
Solana wallet can open from desktop or mobile, plus a hosted checkout flow
that settles in seconds on Solana.
```

(Or close paraphrase — the hard constraint is ZERO `phantom`/`connect wallet`/`wallet.connect` matches in the file after the edit.)

Premissa: wallet-less HARD rule + Premissa 23 (TS SDK canonical surface) + Premissa 25 (DevRel — README is the npm landing page).

Scope (1 file, 1-3 line edit):

1. Edit `packages/widget/README.md` ONLY. No other files.
2. Rewrite ONLY the line containing "Phantom deeplink". Use the replacement above or close paraphrase.
3. Do NOT change any other line in the file — bullet list (Bundle / Distribution / Brand / Callbacks / Fees), Drop-in CDN snippet, supported `data-*` attributes section, JS API examples, all unchanged.
4. Do NOT add a NEW paragraph explaining wallet-less philosophy — the replacement line above is sufficient.

Validation:
- `grep -ic 'phantom' packages/widget/README.md` returns `0`.
- `grep -c 'solana:' packages/widget/README.md` returns `>=1`.
- `wc -l packages/widget/README.md` within ±2 of the pre-edit line count.
- `npm run build` unaffected — markdown.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-readme-walletless`. Open PR titled `docs(widget): wallet-less README first paragraph rewrite`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. @zettapay/embed README.md — wallet-less cross-reference rewrite
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'embed: wallet-less README cross-ref rewrite',
$$Rewrite the cross-reference-to-widget paragraph in `packages/embed/README.md` to remove the "Phantom deeplink" wallet name-drop. The README is rendered as the public npmjs.com page for `@zettapay/embed` and the name-drop contradicts the wallet-less HARD rule.

Verified state on main of `packages/embed/README.md` (line 12-14):

```
Need a full modal + Phantom deeplink + hosted checkout? Use
`@zettapay/widget`. Use `@zettapay/embed` when you want the smallest
possible payload on the merchant site.
```

Replacement (no Phantom name-drop):

```
Need a full modal with a hosted checkout flow + a `solana:` URI that any
Solana wallet can open? Use `@zettapay/widget`. Use `@zettapay/embed`
when you want the smallest possible payload on the merchant site.
```

(Or close paraphrase — zero `phantom`/`connect wallet`/`wallet.connect` matches after the edit.)

Premissa: wallet-less HARD rule + Premissa 23 + Premissa 25.

Scope (1 file, 1-2 line edit):

1. Edit `packages/embed/README.md` ONLY. No other files.
2. Rewrite ONLY the cross-reference paragraph (the one containing "Phantom deeplink"). Use the replacement above or close paraphrase.
3. Do NOT touch any other line in the file.

Validation:
- `grep -ic 'phantom' packages/embed/README.md` returns `0`.
- `grep -c '@zettapay/widget' packages/embed/README.md` returns `>=1` (cross-reference preserved).
- `wc -l packages/embed/README.md` within ±2 of pre-edit.
- `npm run build` unaffected.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-readme-walletless`. Open PR titled `docs(embed): wallet-less README cross-ref to @zettapay/widget`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. Root README.md — wallet-less rewrite of 4 Phantom name-drops
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'root README: wallet-less rewrite of 4 Phantom name-drops',
$$Rewrite the four Phantom wallet name-drops in the ROOT `README.md` to wallet-neutral phrasing. The root README is the GitHub landing page for the repo and the most-visible doc in the project; it currently contradicts the wallet-less HARD rule that the landing page (PR #243 + #256) and the dashboard (PR #164) already align with.

Verified state on main of `README.md`:

- **Line 14** (Install snippet comment): `# drop-in checkout button + modal + Phantom deeplink + hosted flow`
- **Line 56** (POST /merchants/register description): `Receives a Phantom wallet pubkey, creates the merchant's USDC ATA on`
- **Line 62** (JSON request example): `{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<phantom-pubkey>" }`
- **Line 91** (Features bullet): `- Merchant onboarding via Phantom wallet`

Suggested replacements (or close paraphrase per ZERO `phantom` matches):

- Line 14 → `# drop-in checkout button + modal + QR code + hosted flow`
- Line 56 → `Receives a Solana wallet pubkey, creates the merchant's USDC ATA on`
- Line 62 → `{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<solana-pubkey>" }`
- Line 91 → `- Merchant onboarding via Solana wallet pubkey` (or `- Merchant onboarding — paste any Solana wallet pubkey, no connect required`)

Premissa: wallet-less HARD rule + Premissa 25 (DevRel — README is the GitHub landing page).

Scope (1 file, 4-6 line edits):

1. Edit `README.md` (the ROOT file, NOT `packages/*/README.md`) ONLY. No other files.
2. Replace each of the four Phantom name-drops with wallet-neutral phrasing per the suggestions above (or close paraphrase). Hard constraint: `grep -ic 'phantom' README.md` returns `0` after the edit.
3. Do NOT change the rest of the README — badge row, Live deployment table, Tech Stack, Setup, the rest of Endpoints, the Features bullet that mentions MoonPay (allowed — MoonPay is a fiat onramp not a wallet name-drop, and PR #243 + #256 already navigated the MoonPay marketing-copy canon), Protocol spec section, etc.
4. Do NOT add an `## Wallet-less philosophy` section — that is a strategic call.

Validation:
- `grep -ic 'phantom' README.md` returns `0`.
- `grep -c 'Café Tatuapé' README.md` returns `>=1` (example unchanged in identity).
- `grep -c 'MoonPay' README.md` returns `>=1` (the fiat-onramp Features bullet preserved).
- `grep -c 'walletAddress' README.md` returns the same count as on main (`>=1`).
- `wc -l README.md` within ±2 of pre-edit.
- `npm run build` unaffected.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-root-readme-walletless`. Open PR titled `docs: wallet-less rewrite of root README (4 Phantom name-drops)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. packages/sdk-php/composer.json — add Packagist support block
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-php: add Packagist support block (issues+source)',
$$Add the missing `support` block to `packages/sdk-php/composer.json`. The Packagist analogue of npm `bugs`+`repository` (covered for the three TS packages in PR #258) is the [`support` object per Composer schema](https://getcomposer.org/doc/04-schema.md#support). The Packagist project page renders "Issues" and "Source" navigation buttons only when the `support` block is populated; without it the page has only a "Homepage" link and no path to filing a bug or browsing source.

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

Missing: the `support` object. Same adoption-funnel-leak the TS-lane metadata triad in PR #258 closed for npm.

Premissa 23 (SDK-first canonical — all SDKs equal-class on registry discovery) + Premissa 25 (DevRel — Packagist project metadata is free distribution) + Premissa 31 (open source SDKs MIT — contribution path must be public for every SDK).

Scope (1 file, ~5 LOC added):

1. Edit `packages/sdk-php/composer.json` ONLY. No other files.
2. Add exactly this top-level field (placement: between `homepage` and `require` reads cleanest; Composer does not enforce key order):

   "support": {
     "issues": "https://github.com/leandromaiam-code/zettapay/issues",
     "source": "https://github.com/leandromaiam-code/zettapay"
   }

3. Do NOT touch `name`, `description`, `keywords`, `homepage`, `require`, `require-dev`, `autoload`, `autoload-dev`, `config`, `minimum-stability`, or any other field.
4. Do NOT add `support.email` or `support.docs` or `support.chat` — those each need an ops decision and risk bikeshed.

Validation:
- `php -r "echo json_decode(file_get_contents('packages/sdk-php/composer.json'))->support->issues;"` prints `https://github.com/leandromaiam-code/zettapay/issues`.
- `python3 -c "import json; d=json.load(open('packages/sdk-php/composer.json')); print(d['support']['source'])"` prints `https://github.com/leandromaiam-code/zettapay`.
- `composer validate packages/sdk-php/composer.json --no-check-publish --no-check-lock` returns "is valid" (if Composer is on PATH; the existing CI workflow queued in PR #251 will revalidate).
- `npm run build` unaffected (PHP file, no JS compile).
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-sdk-php-support`. Open PR titled `chore(sdk-php): add Packagist support block (issues+source)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', 'e365137f',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/e365137f-backlog-refill.md',
     'companion_sql', 'docs/discovery/e365137f-backlog-refill.sql',
     'pass_number', 11,
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', 'a82d92db'),
       jsonb_build_object('pr', 253, 'uuid_prefix', '9db4cb78'),
       jsonb_build_object('pr', 254, 'uuid_prefix', 'bf6837e4'),
       jsonb_build_object('pr', 257, 'uuid_prefix', 'd5806497'),
       jsonb_build_object('pr', 258, 'uuid_prefix', '66b549af')
     ),
     'missions_inserted', jsonb_build_array(
       'widget: strip "phantom" from npm keywords (wallet-less)',
       'widget: wallet-less README first paragraph rewrite',
       'embed: wallet-less README cross-ref rewrite',
       'root README: wallet-less rewrite of 4 Phantom name-drops',
       'sdk-php: add Packagist support block (issues+source)'
     ),
     'themes', jsonb_build_array(
       'wallet-less-hard-rule-enforcement-on-public-readmes',
       'wallet-less-hard-rule-enforcement-on-widget-npm-keywords',
       'packagist-project-metadata-parity-sdk-php'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/widget/package.json (keywords array edit)',
       'packages/widget/README.md (markdown, single-paragraph)',
       'packages/embed/README.md (markdown, single-paragraph)',
       'README.md root (markdown, 4 line edits)',
       'packages/sdk-php/composer.json (metadata-only)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'packages/widget/src/modal.ts Phantom-deeplink refactor (real refactor, separate mission)',
       'per-SDK LICENSE file parity (4 separate missions, tooling does not require)',
       'version bumps (no version field touched)',
       'multi-file refactors',
       'strategic / ops decisions (CODE_OF_CONDUCT, FUNDING, CHANGELOG, CODEOWNERS, support.email, support.chat)',
       'ESLint / Prettier / PHP-CS code-style tooling',
       'TS SDK examples/quickstart.ts (bundling-vs-stub design call)'
     )
   ));

COMMIT;
