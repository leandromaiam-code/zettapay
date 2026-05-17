-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 2e05f052
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/2e05f052-backlog-refill.md
-- All 5 picks are single-file, single-objective, additive, and outside the
-- chronic-broken packages/api compile lane. None touch wallet-adapter UI
-- and none call wallet.connect() / window.solana.connect().
--
-- Themes covered: untested widget/embed modules (qr.ts, poll.ts),
-- dangling-reference cleanup (HALL_OF_FAME.md for queued security.txt),
-- AI-agent discoverability (llms.txt), and Anchor on-chain static-analysis
-- CI gating. Prior seven refills drained the per-SDK CI / per-SDK
-- CONTRIBUTING / npm-meta / wallet-less-rewrite / supply-chain /
-- trust-signal lanes.
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. widget — cover qr.ts (the only untested widget module; pure SVG logic)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'widget: cover qr.ts with vitest',
$$Add a new test file `packages/widget/test/qr.test.ts` that unit-tests the public surface in `packages/widget/src/qr.ts` (52 LOC). Today `packages/widget/test/` holds only `widget.test.ts` — `qr.ts` is the only pure-logic widget module without a peer test file. Premissa 29 requires coverage > 70% on critical paths; `qr.ts` IS the critical path because it generates the QR code customers scan to pay (wallet-less HARD-rule canonical hand-off). A silent regression (off-by-one cell, wrong viewBox, broken `<rect>`) prints a QR that doesn't decode and the merchant loses the sale.

Scope (1 new file, ~80-120 LOC):

1. Create `packages/widget/test/qr.test.ts`.
2. Cover `renderQrSvg(payload, options)` with at minimum these cases:
   - Default options — `renderQrSvg('hello')` returns a string starting with `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"` and ending with `</svg>`.
   - Custom size — `renderQrSvg('hello', { size: 512 })` produces `viewBox="0 0 512 512"` and the outer `width="512" height="512"`.
   - Custom dark/light colors — `renderQrSvg('hello', { dark: '#ff0000', light: '#00ff00' })` contains `fill="#00ff00"` for the background `<rect>` and `fill="#ff0000"` for the `<g>` group.
   - Error correction levels — call with each of `'L' | 'M' | 'Q' | 'H'` and assert the function returns a non-empty SVG string (no exception). Higher levels should typically have more cells; assert level `'H'` output is at least as long as level `'L'` for the same payload (cell density correlates with EC level).
   - Payload determinism — calling twice with the same payload+options returns byte-identical output.
   - Long payload — a 200-character Solana Pay URI (`solana:HX...?amount=10.5&reference=...`) produces a valid SVG with at least one `<rect>` cell and no NaN / Infinity in coordinate strings.
3. Use `describe('renderQrSvg', () => { ... })` with `it` blocks per case. Import `renderQrSvg` from `../src/qr.js` (mirror the `.js` extension convention used in `widget.test.ts`).
4. Do NOT snapshot the full SVG with `@vitest/snapshot`; assert structurally (substring + viewBox + cell-count regex). Snapshot churn obscures real regressions.
5. Do NOT refactor `qr.ts` — tests only. If the type-narrowing of options reveals a bug, file a separate mission; this PR is coverage-only.
6. Do NOT add `qrcode-generator` mocks; use the real library (it's deterministic and offline).

Validation:
- `cd packages/widget && npm run test` exits 0 with the new file's tests passing.
- `grep -c '^import' packages/widget/test/qr.test.ts` returns at least 2 (vitest + qr).
- `npm run build` unaffected (test files excluded by `tsconfig.build.json` allow-list per worker memory `feedback_tsconfig_build_allowlist.md`).
- Wallet-less hard rule N/A — no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-widget-qr-tests`. Open PR titled `test(widget): cover qr.ts with vitest`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. embed — cover poll.ts (settlement-detection critical path, non-custodial guarantee)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'embed: cover poll.ts with vitest',
$$Add a new test file `packages/embed/test/poll.test.ts` that unit-tests `startPoller` and the `Poller` interface exported from `packages/embed/src/poll.ts` (118 LOC). Today `packages/embed/test/` has `embed.test.ts` + `wallets.test.ts`; `poll.ts` is uncovered even though it's the single most load-bearing module in the embed — Premissa 14 says we don't custody, so polling correctness is the only way merchants learn they were paid. Premissa 29 (coverage > 70% on critical paths) is the gate.

Scope (1 new file, ~130-180 LOC):

1. Create `packages/embed/test/poll.test.ts`.
2. Mock `../src/rpc.js` with `vi.mock('../src/rpc.js', () => ({ getSignaturesForAddress: vi.fn(), getParsedTransaction: vi.fn() }))`. Import the mocked functions back for per-test setup.
3. Use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach` so tick advancement is deterministic. Advance via `await vi.advanceTimersByTimeAsync(intervalMs)`.
4. Cover these cases under one `describe('startPoller', ...)` block:
   - **Happy path** — `getSignaturesForAddress` returns `[{ signature: 'sig1' }]` on tick 1, then `getParsedTransaction('sig1')` returns a parsed transfer matching `(mint, amount, recipient)`. Assert `onMatch` is called exactly once with `('sig1', <blockTime>)` and the poller stops itself (further ticks make no RPC calls).
   - **De-dup** — same `signature: 'sig1'` returned across two ticks. Assert `onMatch` fires at most once and `getParsedTransaction` is called at most once for that signature.
   - **Amount mismatch** — signature parses to a transfer to `recipient` with the right mint but the wrong `amountBaseUnits`. Assert `onMatch` does NOT fire and the poller keeps polling.
   - **Mint mismatch** — signature parses to a transfer with the wrong mint. Assert `onMatch` does NOT fire.
   - **Error tolerance** — `getSignaturesForAddress` throws `new Error('rpc flake')` on tick 1, returns normally on tick 2. Assert `onError` is called once with the thrown error and the loop continues to tick 2.
   - **stop() halts the loop** — call `startPoller(...).stop()` immediately after creation. Advance timers by `10 * intervalMs`. Assert `getSignaturesForAddress` is NOT called (or called at most once if the first tick is synchronous), and `onMatch`/`onError` are NEVER called.
5. Use a builder helper like `function makeParams(overrides = {}): PollParams` to keep each `it` short.
6. Do NOT refactor `poll.ts` — tests only. Do NOT cover `rpc.ts` / `ui.ts` / `types.ts` in this PR; each becomes its own mission.
7. Do NOT introduce a real Solana RPC dependency or hit any network endpoint.

Validation:
- `cd packages/embed && npm run test` exits 0 with the new file's tests passing.
- `grep -c "describe\\|it(" packages/embed/test/poll.test.ts` returns at least 7 (1 describe + 6 it).
- `grep -c "vi\\.useFakeTimers" packages/embed/test/poll.test.ts` returns at least 1.
- `npm run build` unaffected (test files excluded by `tsconfig.build.json` allow-list).
- Wallet-less hard rule N/A — no wallet code; `poll.ts` only watches addresses passed in by the caller.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-embed-poll-tests`. Open PR titled `test(embed): cover poll.ts settlement loop with vitest`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. HALL_OF_FAME.md — resolve dangling reference from queued security.txt mission
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'audit: ship HALL_OF_FAME.md (security.txt referent)',
$$Create a new file `audit/HALL_OF_FAME.md` so the `Acknowledgments` URL referenced by the queued `public/.well-known/security.txt` mission (uuid prefix `03cf9a17`) resolves on the day `security.txt` deploys rather than 404-ing on security researchers' first click. The dangling reference was explicitly flagged as a known follow-up in pass `1986ee3d` (line 58-63 of `docs/discovery/1986ee3d-backlog-refill.md`). Premissa 19 ($50k public bug bounty pre-mainnet) treats researcher experience as part of the bounty surface.

Scope (1 new file, ~30-50 lines markdown):

1. Create `audit/HALL_OF_FAME.md`.
2. File contents must include, in this order:
   - `# ZettaPay Hall of Fame — Security Researchers` (H1)
   - A short paragraph explaining the page: who's listed and why; entries are added post-disclosure + post-patch, with the researcher's consent; entries credit the researcher (handle or full name, at their choice), the CVE / advisory ID if assigned, the affected component, and the date of public disclosure.
   - `## How to be listed` (H2). One paragraph pointing to `audit/BUG_BOUNTY.md` for the report-flow and `mailto:security@zettapay.dev` for first contact. Mention that researchers who responsibly disclose are eligible for both this listing and the cash bounty in `audit/BUG_BOUNTY.md`.
   - `## 2026` (H2). One placeholder line: `_No public disclosures yet. Be the first._`
   - `## See also` (H2). Bullet list with 2 entries:
     - `[audit/BUG_BOUNTY.md](./BUG_BOUNTY.md) — bounty policy, scope, and reward tiers`
     - `[/.well-known/security.txt](https://zettapay.vercel.app/.well-known/security.txt) — RFC 9116 disclosure metadata (once deployed)`
3. Use plain markdown — no YAML frontmatter, no HTML, no emoji.
4. Do NOT invent fictional researcher names. Do NOT promise specific reward dollar amounts (those live in `BUG_BOUNTY.md`). Do NOT add a CVE table (premature — we have no public disclosures yet).

Validation:
- `cat audit/HALL_OF_FAME.md` shows all required headings (`# ZettaPay Hall of Fame`, `## How to be listed`, `## 2026`, `## See also`).
- `grep -c "^# ZettaPay Hall of Fame" audit/HALL_OF_FAME.md` returns 1.
- `grep -c "^## " audit/HALL_OF_FAME.md` returns 3.
- `grep -c "BUG_BOUNTY.md" audit/HALL_OF_FAME.md` returns at least 2 (one in body, one in See also).
- `npm run build` unaffected (markdown, no compile).
- Wallet-less hard rule N/A — no wallet code.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-hall-of-fame`. Open PR titled `docs(audit): ship HALL_OF_FAME.md (security.txt referent)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. llms.txt — AI-agent / LLM-crawler discoverability for the protocol surface
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'discovery: ship public/llms.txt (AI-agent protocol)',
$$Create a new file `public/llms.txt` so LLM crawlers (Claude, GPT, Gemini, Perplexity, You.com) discover the ZettaPay protocol surface via the emerging community standard proposed by Jeremy Howard and adopted by Anthropic-docs, Mintlify, and Vercel. The primary persona (Premissa 6, 8) is AI agents paying via x402 + MCP; the moat (Premissa 8) is being maximally agent-discoverable. `security.txt` (queued) makes the bounty researcher-discoverable; this is the parallel surface for AI agents. Premissa 25 (DevRel + open SDK > paid marketing) is the strategic anchor.

Scope (1 new file, ~50-80 lines plain text / markdown):

1. Create `public/llms.txt` (Vercel serves `public/` as static assets, so the file is reachable at `https://zettapay.vercel.app/llms.txt` without any `vercel.json` rewrite).
2. File contents must follow the de-facto llms.txt convention — H1 site name, short summary, H2 sections with bullet-listed canonical URLs. Required sections:
   - `# ZettaPay` (H1)
   - One- to two-sentence summary describing ZettaPay as a multicoin non-custodial P2P confirmation-tracking protocol with x402 + MCP support for AI agents. **CRITICAL:** do NOT use the banned marketing claims from worker memory `project_canon_2026_05_16.md` — specifically NO `0.30% fee`, NO `MoonPay`, NO `Phantom-built`, NO `revolution / disruption / sinergia / game-changer`. State protocol facts only.
   - `## Docs` (H2). Bullet list with each entry shaped `- [Page name](URL): one-line description`. Include `/docs/quickstart`, `/docs/api`, `/docs/webhook`, `/docs/embed`. Use absolute URLs (`https://zettapay.vercel.app/docs/quickstart`) so LLM crawlers don't need to resolve relative paths.
   - `## Protocol surfaces` (H2). Bullet list of public spec / discovery URLs: `/.well-known/mcp.json` (note: queued, may 404 until landed), `/api/mcp`, the GitHub repo `https://github.com/leandromaiam-code/zettapay`, the canonical x402 protocol spec URL (use `https://github.com/coinbase/x402` if that's the canonical spec source; otherwise leave a TODO placeholder for the human reviewer to fill in).
   - `## Optional` (H2). Bullet list: `/sitemap.xml` for full crawl, `/audit/BUG_BOUNTY.md` for security disclosure, the SDK packages on npm / PyPI / crates.io / Packagist / pkg.go.dev with their canonical URLs.
3. Use plain UTF-8, LF line endings. No YAML frontmatter, no HTML, no emoji.
4. Do NOT add `User-Agent: GPTBot Allow: /` style robots directives — that belongs in `public/robots.txt` (separate mission).
5. Do NOT add a `<noscript>` / `<meta>` fallback — `llms.txt` is plain text only.
6. Do NOT include pricing, fee percentages, or settlement-time claims that aren't backed by current production code (worker memory `project_canon_2026_05_16.md` bans `0.30%` and `MoonPay`).

Validation:
- `cat public/llms.txt` shows the four required H2 sections (`## Docs`, `## Protocol surfaces`, `## Optional` — plus the H1).
- `grep -c "^# ZettaPay$" public/llms.txt` returns 1.
- `grep -c "^## " public/llms.txt` returns at least 3.
- `grep -cE "0\\.30%|MoonPay|Phantom-built|revolution|disruption|sinergia|game-changer" public/llms.txt` returns 0 (banned-phrases gate, worker memory `project_canon_2026_05_16.md`).
- After deploy, `curl -sI https://zettapay.vercel.app/llms.txt` returns 200 with `Content-Type: text/plain` (Vercel infers from `.txt`).
- `npm run build` unaffected (static asset, no compile).
- Wallet-less hard rule: `grep -cE "wallet\\.connect|window\\.solana\\.connect|Connect Wallet|Connect Phantom" public/llms.txt` returns 0.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-llms-txt`. Open PR titled `chore: ship public/llms.txt (AI-agent protocol surface)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. CI workflow — wire existing scripts/static-analysis-rust.sh to GH Actions
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci(programs): wire static-analysis-rust.sh to GH Actions',
$$Create `.github/workflows/static-analysis-rust.yml` so every push to `main` and every PR that touches `programs/zettapay/**` or the script itself runs `bash scripts/static-analysis-rust.sh`. The script is a 150+ line offline Sec3 X-ray + Soteria heuristics scan covering the eight check classes (X-001..X-008 + S-001..S-002) the mainnet audit prep (Premissa 18 / Z21) requires. It's already wired to `npm run audit:static-rust` in root `package.json`, but the only workflows in `.github/workflows/` today are `npm-publish.yml` and `sdk-go.yml` — no PR runs `audit:static-rust`. Premissa 18 (smart contracts audited before mainnet) is the load-bearing rule; this offline complement runs on every PR so a regression between cloud Sec3 / Halborn scans (which we only invoke at audit milestones) trips locally and blocks merge.

Scope (1 new file, ~28-40 LOC):

1. Create `.github/workflows/static-analysis-rust.yml`.
2. Workflow contents (use this verbatim; the script has no rust-toolchain or setup dependencies — it greps and counts on .rs files only):
   ```yaml
   name: static-analysis-rust

   on:
     push:
       branches: [main]
       paths:
         - 'programs/zettapay/**'
         - 'scripts/static-analysis-rust.sh'
         - '.github/workflows/static-analysis-rust.yml'
     pull_request:
       paths:
         - 'programs/zettapay/**'
         - 'scripts/static-analysis-rust.sh'
         - '.github/workflows/static-analysis-rust.yml'

   jobs:
     scan:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - name: Run static analysis
           run: bash scripts/static-analysis-rust.sh
   ```
3. Trigger paths MUST include both `programs/zettapay/**` (the source under scan) AND `scripts/static-analysis-rust.sh` (so changes to the scan itself re-run on PR) AND the workflow file itself (so workflow edits don't bypass).
4. Do NOT modify `scripts/static-analysis-rust.sh` in this PR — wiring only. If the script is currently failing on `main`, that's a separate triage mission (worker memory `feedback_anchor_bump_static_analysis.md` documents one known false-positive class).
5. Do NOT add Sec3 / Soteria cloud-runner steps — those need secrets + billing and are run at audit milestones, not per-PR.
6. Do NOT promote the workflow to required-status-check in this PR — that's a separate repo-admin mission.

Validation:
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/static-analysis-rust.yml'))"` exits 0 (valid YAML). Fall back to `node -e "require('yaml').parse(require('fs').readFileSync('.github/workflows/static-analysis-rust.yml','utf8'))"` if Python isn't available.
- `grep -c "static-analysis-rust\\.sh" .github/workflows/static-analysis-rust.yml` returns at least 3 (one in each `paths:` block + one in `run:`).
- `grep -c "paths:" .github/workflows/static-analysis-rust.yml` returns exactly 2 (push + pull_request).
- `grep -c "actions/checkout@v4" .github/workflows/static-analysis-rust.yml` returns 1.
- The workflow appears in the GitHub Actions tab after push (manual verification — no setup-rust step means cold-start is sub-30s).
- Run on this PR's branch using `act` locally is OPTIONAL — the workflow only fires on paths under `programs/` or the script; this PR doesn't touch those paths so the workflow won't fire on the workflow's own introducing PR. That's expected; a follow-up PR touching `programs/` will exercise it.
- `npm run build` unaffected (workflows are not compiled).
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-ci-static-analysis-rust`. Open PR titled `ci(programs): wire static-analysis-rust.sh to GitHub Actions`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit-journal entry — record this auto-regen pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', '2e05f052',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/2e05f052-backlog-refill.md',
     'companion_sql', 'docs/discovery/2e05f052-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', '9db4cb78'),
       jsonb_build_object('pr', 253, 'uuid_prefix', '07e4ac3'),
       jsonb_build_object('pr', 254, 'uuid_prefix', '4848330'),
       jsonb_build_object('pr', 257, 'uuid_prefix', '4330964'),
       jsonb_build_object('pr', 258, 'uuid_prefix', 'af9fd69'),
       jsonb_build_object('pr', 259, 'uuid_prefix', '87fcb3c')
     ),
     'missions_inserted', jsonb_build_array(
       'widget: cover qr.ts with vitest',
       'embed: cover poll.ts with vitest',
       'audit: ship HALL_OF_FAME.md (security.txt referent)',
       'discovery: ship public/llms.txt (AI-agent protocol)',
       'ci(programs): wire static-analysis-rust.sh to GH Actions'
     ),
     'themes', jsonb_build_array(
       'widget-test-coverage',
       'embed-test-coverage',
       'dangling-reference-cleanup',
       'ai-agent-discoverability',
       'anchor-static-analysis-ci'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/widget/test (vitest workspace, green)',
       'packages/embed/test (vitest workspace, green)',
       'audit/ (markdown, non-compile)',
       'public/ (static asset, non-compile)',
       '.github/workflows (CI config, non-compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors',
       'banned-canon copy (0.30%, MoonPay, Phantom-built)',
       'strategic / release-ops decisions (CHANGELOG, FUNDING)'
     )
   ));

COMMIT;
