-- Auto-discovery backlog refill — generated 2026-05-16
-- Source mission UUID prefix: 69cdcbce
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/69cdcbce-backlog-refill.md
-- All 5 picks sourced from the Z33E site-audit (PR #241) re-validated at
-- mission-generation time. Wallet-less HARD rule preserved on every target.
--
-- The mission worker could not reach Supabase MCP directly (see worker memory
-- feedback_supabase_mcp_unavailable.md); these statements are the canonical
-- payload the orchestrator (or a human operator with the service-role key)
-- should apply on merge.
--
-- All inserts are idempotent against (workspace_id, name) — re-running is
-- safe if mission rows are de-duplicated upstream by name.

BEGIN;

-- 1. OG meta + placeholder image (Z33E gap #1)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'site: OG meta + placeholder og-image on public/index.html',
$$Add Open Graph + Twitter card meta tags to `public/index.html` and ship a placeholder `public/og-image.svg` so social shares render with a brand preview instead of a text-only link. Sourced from the Z33E site-audit (`docs/audit/site-gaps-2026-05-16.md`, gap #1).

Scope (2 files, tight):

1. Create `public/og-image.svg` — a 1200×630 SVG using the Veridian palette (Forest `#0a1612` background, Brass `#d4a961` for the ZettaPay wordmark, Parchment `#f5e6c8` for the tagline). One-liner tagline: `"Pagamentos programáticos para AI Agents."` Pure SVG, no external font (use a generic serif fallback or embed paths). Size budget: < 8 KB. SVG is fine for Vercel — Twitter/X and LinkedIn rasterise it server-side. PNG can come later in a follow-up mission if real-world rendering proves the SVG approach insufficient.

2. In `public/index.html`, inside the existing `<head>` block (right after the current `og:title` / `og:description` meta tags), insert:

   ```html
   <meta property="og:image" content="https://zettapay.vercel.app/og-image.svg" />
   <meta property="og:image:width" content="1200" />
   <meta property="og:image:height" content="630" />
   <meta property="og:image:type" content="image/svg+xml" />
   <meta property="og:url" content="https://zettapay.vercel.app/" />
   <meta property="og:type" content="website" />
   <meta name="twitter:card" content="summary_large_image" />
   <meta name="twitter:image" content="https://zettapay.vercel.app/og-image.svg" />
   ```

Out of scope (do **not** touch this PR): the other 19 HTML pages. The homepage is by far the most-shared URL; ship it first to validate the asset, then a follow-up mission can fan out across the site.

Validation:
- `grep -c 'og:image' public/index.html` returns >= 3 (image + width + height).
- `ls -la public/og-image.svg` shows the file < 8 KB.
- Visual check: open `public/og-image.svg` in a browser — readable wordmark + tagline.
- `npm run build` unaffected (HTML/SVG only).
- Wallet-less hard rule N/A — no JS, no wallet code.
- Brand discipline: zero Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-og-meta-index`. Open PR titled `feat(site): OG meta + placeholder og-image for homepage social previews (Z33E gap #1)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 2. Remove broken /simulate/demo footer link (Z33E gap #2)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'site: remove broken /simulate/demo footer link',
$$Remove the `<a href="/simulate/demo">Simulate</a>` footer link at `public/index.html:613`. The link points at `/simulate/:merchant` (a Vercel rewrite to the API function `/api/simulate/:merchant`, not a UI route). Clicking it dumps raw JSON in the browser when the merchant slug matches, and 404s when it doesn't — `demo` is not a registered merchant, so the link 404s today. Sourced from Z33E gap #2.

Scope (1 file, 1-2 lines deleted):

1. In `public/index.html`, locate line 613:
   ```html
   <a href="/simulate/demo" class="hover:text-white transition">Simulate</a>
   ```
   Delete the entire `<a>` tag. If the surrounding `<li>` (or whatever ancestor wraps each footer link) becomes empty as a result, delete that too. Do **not** add a new link or rewrite — a real `/simulate` playground page is out of scope and would belong to a future DevRel mission (audit option B). This mission is purely the surgical removal (audit option A).

2. Re-validate the rest of the footer renders correctly — no orphan separators, no double commas, no empty bullet.

Validation:
- `grep -c 'simulate/demo' public/index.html` returns 0.
- `git diff --stat public/index.html` shows < 5 lines removed, 0 added.
- Manually open `public/index.html` in a browser (or `npx http-server public`) and visually confirm the footer still aligns.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-remove-simulate-demo-link`. Open PR titled `fix(site): remove broken /simulate/demo footer link (Z33E gap #2)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 3. Ship robots.txt + sitemap.xml (Z33E gap #3)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'site: ship robots.txt + sitemap.xml for public/',
$$Create `public/robots.txt` and `public/sitemap.xml` so search crawlers can index the public site without hitting `/api/*` or auth-gated dashboard previews, and so indexing latency drops from weeks to hours. Sourced from Z33E gap #3.

Scope (2 new files, ~100 LOC total):

1. Create `public/robots.txt` with exactly:
   ```
   User-agent: *
   Allow: /
   Disallow: /api/
   Disallow: /dashboard/
   Disallow: /dashboard
   Disallow: /checkout/
   Sitemap: https://zettapay.vercel.app/sitemap.xml
   ```
   (Note: both `/dashboard/` and `/dashboard` are listed because legacy `dashboard.html` is rewritten at the root `/dashboard` path per `vercel.json:66`.)

2. Create `public/sitemap.xml` with one `<url>` block per public HTML page that is actually crawlable. **Include** these 13: `/`, `/pricing`, `/signup`, `/about`, `/contact`, `/privacy`, `/terms`, `/status`, `/launch`, `/docs`, `/docs/quickstart`, `/docs/embed`, `/docs/faucet`. **Exclude** `/checkout/*`, `/dashboard*`, `/pay`, `/404` (transient, gated, or error pages).

   For each URL:
   - `<loc>https://zettapay.vercel.app/<path></loc>`
   - `<lastmod>` = today's date in `YYYY-MM-DD` (`2026-05-16`)
   - `<changefreq>weekly</changefreq>` for `/` and `/pricing`, `monthly` for the rest
   - `<priority>1.0</priority>` for `/`, `0.8` for `/pricing` and `/signup`, `0.6` otherwise

   Use the standard `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` envelope.

3. Verify nothing in `vercel.json` rewrites `/robots.txt` or `/sitemap.xml` — they should be served as static files directly from `public/`. If a catch-all rewrite would intercept them, add an explicit pass-through entry to the `rewrites` array.

Validation:
- `curl -s http://localhost:3000/robots.txt` (or `npx http-server public`) returns the exact text above.
- `xmllint --noout public/sitemap.xml` exits 0 (well-formed XML). If `xmllint` is not installed, run `node -e "require('xml2js').parseStringPromise(require('fs').readFileSync('public/sitemap.xml','utf8')).then(()=>console.log('ok'))"`.
- `grep -c '<url>' public/sitemap.xml` returns exactly 13.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-robots-sitemap`. Open PR titled `feat(site): ship robots.txt + sitemap.xml for crawler hygiene (Z33E gap #3)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 4. Fix <html lang> outlier on pay.html (Z33E gap #4)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'site: fix <html lang> on pay.html (pt-BR → en)',
$$Change `<html lang="pt-BR">` to `<html lang="en">` at `public/pay.html:2`. All 12 other public HTML pages declare `lang="en"`, but `pay.html` is the lone outlier despite its body content being English ("Amount Due", "Payment Address", etc.). Sourced from Z33E gap #4.

Why this matters (do not skip the validation step below — the audit calls this out as a real accessibility issue, not a cosmetic one):

- Screen readers (NVDA, VoiceOver, JAWS) switch pronunciation rules based on the `lang` attribute. Reading English body text with Portuguese phonemes is broken accessibility for both PT-BR and EN users.
- Google's hreflang signal uses `<html lang>` as a hint; one outlier page misclassifies the geo/language variant.

Out-of-scope (do **not** address in this PR):

- The wider CLAUDE.md premissa 27 ("PT-BR como default de UI") vs the site's current English-only reality. That is a strategic i18n decision flagged for human triage in the audit (`docs/audit/site-gaps-2026-05-16.md` §4). This mission only fixes the surface-level inconsistency.

Scope (1 file, 1 character-cluster change):

1. In `public/pay.html`, change line 2 from:
   ```html
   <html lang="pt-BR">
   ```
   to:
   ```html
   <html lang="en">
   ```

Validation:
- `grep -c 'lang="pt-BR"' public/*.html` returns 0.
- `grep -c 'lang="en"' public/pay.html` returns 1.
- `git diff --stat public/pay.html` shows exactly 1 line changed (1 added, 1 removed).
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-pay-lang-en`. Open PR titled `fix(site): normalise <html lang> on pay.html to "en" (Z33E gap #4)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- 5. Harden signup → dashboard handoff (Z33E gap #5)
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'site: harden signup → dashboard handoff (remove legacy fallback)',
$$Remove the legacy-dashboard fallback at `public/signup.html:808` so a brand-new merchant is never silently routed to the 1,813-line `dashboard.html` when the `/merchants/register` API response is missing `dashboard_url`. Sourced from Z33E gap #5.

Current code (line 808):
```js
dashboardLink.setAttribute('href', result.dashboard_url || '/dashboard');
```
The `|| '/dashboard'` fallback fires whenever the API response omits `dashboard_url` — any backend bug, error response, or older API build silently sends the merchant to the legacy dashboard. Worker memory (`project_dashboard_analytics_split.md`) confirms `/dashboard` resolves to the legacy `dashboard.html`, not the new `/dashboard/<slug>` analytics surface.

Scope (1 file, ~5 lines changed):

1. In `public/signup.html`, locate the block around line 808 that sets `dashboardLink.href`. Replace it with explicit handling:
   ```js
   if (!result.dashboard_url) {
     // Signup succeeded but the API didn't return a dashboard URL.
     // Surface the error to the merchant instead of dumping them on the legacy page.
     dashboardLink.style.display = 'none';
     const errEl = document.createElement('p');
     errEl.className = 'text-sm text-rose-300 mt-3';
     errEl.textContent = 'Signup succeeded but we could not generate your dashboard URL. Please contact support@zettapay.com with your merchant handle.';
     dashboardLink.parentElement.appendChild(errEl);
   } else {
     dashboardLink.setAttribute('href', result.dashboard_url);
   }
   ```
   (Keep the surrounding success-screen logic exactly as it is. Only the `setAttribute` call and the `||` fallback change.)

2. **Do not** touch the nav link at `public/signup.html:262` in this PR (that's a routing decision — landing page vs slug-resolver — flagged for human triage in the audit).

3. **Do not** delete `public/dashboard.html` in this PR (the legacy dashboard removal is a separate routing decision, also flagged for human triage).

Validation:
- `grep -n "|| '/dashboard'" public/signup.html` returns 0 matches.
- `grep -c 'dashboard_url' public/signup.html` returns >= 2 (the read + the explicit check).
- Manually walk the signup flow in a local browser session (`npx http-server public` + a stubbed API that omits `dashboard_url`) and confirm the support-contact paragraph renders instead of the legacy redirect.
- `npm run build` unaffected.
- Wallet-less hard rule N/A.
- Brand discipline: no Claude/Anthropic mentions. Co-author: Veridian Fabric.

Branch: `auto/<uuid>-signup-dashboard-handoff`. Open PR titled `fix(signup): remove legacy /dashboard fallback in signup success handler (Z33E gap #5)`.$$,
   'execution', 'pending', 'auto-regen', 2);

-- Audit journal entry
INSERT INTO fabric_audit_journal (event_type, payload)
VALUES
  ('auto_regen_executed',
   jsonb_build_object(
     'workspace_id', 'c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
     'source_mission_uuid_prefix', '69cdcbce',
     'branch', 'auto/69cdcbce--auto-discovery-identificar-pr-ximos-5-g',
     'generated_at', '2026-05-16',
     'upstream_signal', 'docs/audit/site-gaps-2026-05-16.md (Z33E, PR #241)',
     'missions_created', jsonb_build_array(
       'site: OG meta + placeholder og-image on public/index.html',
       'site: remove broken /simulate/demo footer link',
       'site: ship robots.txt + sitemap.xml for public/',
       'site: fix <html lang> on pay.html (pt-BR → en)',
       'site: harden signup → dashboard handoff (remove legacy fallback)'
     ),
     'rejected_candidates', jsonb_build_object(
       'full_i18n_rebuild', 'Out-of-scope: multi-week i18n layer for CLAUDE.md premissa 27. Strategic decision for Leandro, not auto-merge.',
       'retire_legacy_dashboard_html', 'Out-of-scope: needs a routing decision (slug-resolver cookie vs login-landing). Flagged for human triage in Z33E §5.',
       'privacy_terms_legal_thinness', 'Out-of-scope: needs legal review, not engineering. Z33E "Other gaps observed".',
       'packages_api_chronic_build_repair', 'Out-of-scope: multi-file fix in chronic-broken lane. Worker memory project_build_broken.md.',
       'z29_4_zombie_sentinel_chain', 'Out-of-scope: orchestrator-side UUID stickiness issue, not a code mission.'
     ),
     'notes', 'All 5 picks sourced from Z33E audit (PR #241 merged 2026-05-16). Direct fabric_squad_missions INSERT could not be executed: Supabase MCP unavailable to worker per memory feedback_supabase_mcp_unavailable.md. Orchestrator should apply this SQL post-merge or human operator runs it with service-role key.'
   ));

COMMIT;
