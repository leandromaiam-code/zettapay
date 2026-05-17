-- Auto-discovery backlog refill — generated 2026-05-17
-- Source mission UUID prefix: 9db4cb78
-- Workspace: zettapay (c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b)
--
-- Companion to docs/discovery/9db4cb78-backlog-refill.md
-- All 5 picks are single-objective, additive, and outside the chronic-broken
-- packages/api compile lane. None touch wallet code.
--
-- Themes covered: sdk-rust error inline test parity, sdk-go quickstart
-- example parity, public sitemap.xml SEO surface, wallet-less HARD rule
-- as a CI gate, root CONTRIBUTING.md.
--
-- Prior six refills (fba46358 #231, 69cdcbce #242, 4f79ec06 #244,
-- 03cf9a17 #245, 1986ee3d #251, a82d92db #252) drained the
-- single-objective / site-launch / SDK+Vercel-API / test-CI-DX /
-- SDK-parity-supply-chain / SDK-test+MCP+editorconfig queues. This pass
-- attacks the next-layer gaps: cross-SDK polyglot parity (rust inline
-- error test, go examples dir), discoverability (sitemap.xml), HARD-rule
-- preventive gating (wallet-less workflow), and root-level contributor
-- onboarding (CONTRIBUTING.md).
--
-- The mission worker could not reach Supabase MCP directly (see worker
-- memory feedback_supabase_mcp_unavailable.md); these statements are the
-- canonical payload the orchestrator (or a human operator with the
-- service-role key) should apply on merge.
--
-- All inserts are deduplicable upstream by (workspace_id, name).

BEGIN;

-- 1. sdk-rust: error.rs inline #[cfg(test)] mod tests — parity with TS / Go / Python error tests
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-rust: inline tests for error.rs (is_code + is_status + is_retryable)',
$$Add an inline `#[cfg(test)] mod tests` block to packages/sdk-rust/src/error.rs
so the Display formatter, is_code, is_status, and the crate-private
is_retryable() decision cannot silently regress. The TypeScript SDK
shipped its peer (packages/sdk/test/errors.test.ts) in PR #234; the Go
SDK and Python SDK have their peers queued (UUID prefix a82d92db, PR
#252). Rust is the remaining language gap. Premissa 23 (SDK-first
multi-language parity) + Premissa 29 (coverage > 70% on critical paths —
the error classifier IS the critical path for every consumer's retry /
abort / surface-to-user decision).

The is_retryable() method is `pub(crate)`, so the test MUST be inline in
error.rs (not in a `tests/` integration test, which only sees `pub`).
The other three (Display, is_code, is_status) are public but co-locating
keeps the diff to a single file.

Scope (1 file modified, ~140 LOC added at the bottom of error.rs):

Append a `#[cfg(test)] mod tests { ... }` block covering four independently
testable units:

1. `Display` formatter:
   - With `status_code: Some(s)`: formats as
     "zettapay: <message> (code=<code>, status=<status>)".
   - With `status_code: None`: formats as
     "zettapay: <message> (code=<code>)".
   - Drive with a small helper `fn err(code, msg, status: Option<u16>) -> Error`
     that constructs via the public fields (test module is in-crate, so
     `pub(crate)` constructors and private fields are reachable).

2. `is_code(&self, &str) -> bool`:
   - True for matching code (e.g. "not_found").
   - False for mismatched code (e.g. "rate_limited").
   - Case-sensitive (Rust string ==).

3. `is_status(&self, u16) -> bool`:
   - True for matching Some(status).
   - False for mismatched status.
   - False when status_code is None (transport failure).

4. `is_retryable(&self) -> bool`:
   - True for `None` (transport failure / no status).
   - True for `Some(429)`.
   - True for `Some(500)`, `Some(503)`, `Some(599)` (full 5xx range).
   - False for `Some(200)`, `Some(301)`, `Some(400)`, `Some(401)`,
     `Some(403)`, `Some(404)`, `Some(422)`.

Use a single private helper to construct Error values inside the test
module:

  fn mk(code: &str, msg: &str, status: Option<u16>) -> Error {
      Error { code: code.into(), message: msg.into(), status_code: status, details: None }
  }

Style mirrors packages/sdk-rust/src/retry.rs and webhook.rs which already
ship inline `#[cfg(test)] mod tests`.

Anti-scope:
- Do NOT change any public or pub(crate) signature in error.rs.
- Do NOT add a new dependency (no `pretty_assertions`, no `rstest`).
  Standard `assert_eq!` / `assert!` are sufficient.
- Do NOT add tests for the `From<reqwest::Error>`, `From<url::ParseError>`,
  or `From<serde_json::Error>` impls — those require live transport
  failures or third-party error fakes; defer to a future integration mission.
- Do NOT touch error.rs above the new `#[cfg(test)] mod tests` block.

Validation:
1. `cd packages/sdk-rust && cargo test --lib error::tests` — all new tests
   green.
2. `cd packages/sdk-rust && cargo build` — no warnings on the inline mod.
3. `cd packages/sdk-rust && cargo clippy --all-targets -- -D warnings` —
   no new lint diagnostics.
4. Brand discipline: no Claude / Anthropic mention in code or commit
   message; co-author tag is Veridian Fabric.
5. Wallet-less HARD rule: `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" packages/sdk-rust/src/error.rs`
   returns zero matches (vacuous; kept for audit-log uniformity).

Conflicts:
- None — confirmed by checking `grep -c "#\[cfg(test)\]" packages/sdk-rust/src/error.rs`
  on main HEAD (commit 6902c9a) returns 0. No open PR targets this file.

References:
- Sibling pattern: packages/sdk-rust/src/retry.rs `#[cfg(test)]` block.
- TS peer test: packages/sdk/test/errors.test.ts (PR #234).
- Go peer test mission (queued): a82d92db pass, mission name
  "sdk-go: test errors.go (IsCode + IsStatus + retryable)" (PR #252).
- Python peer test mission (queued): a82d92db pass, mission name
  "sdk-python: test errors.py (ZettaPayError + retryable)" (PR #252).$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 2. sdk-go: examples/quickstart.go — parity with sdk-rust + sdk-python examples
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'sdk-go: examples/quickstart.go (parity with rust/python quickstart)',
$$Add an `examples/quickstart.go` runnable program to the Go SDK so the
README's "Quick start" code block is also a buildable artifact. The Rust
SDK ships `packages/sdk-rust/examples/quickstart.rs`; the Python SDK
ships `packages/sdk-python/examples/quickstart.py`. The Go SDK currently
has no examples/ directory at all. Premissa 23 (SDK-first
multi-language parity) + Premissa 25 (DevRel + open SDK > paid marketing
— first-touch developers copy the example).

Scope (1 new file, ~110 LOC):

Create packages/sdk-go/examples/quickstart.go in `package main` (separate
from the library package `zettapay`) and walk the same happy-path flow
the Rust example walks:

1. Read env vars: ZETTAPAY_BASE_URL (default http://localhost:3000),
   ZETTAPAY_API_KEY (optional), ZETTAPAY_SIGNED_TX_BASE64 (optional —
   skip payment step if absent; the SDK does not sign transactions).
2. Build a `zettapay.Client` with `DefaultRetryPolicy()` and a 10s timeout.
3. Call `client.Health(ctx)` and print status + counts.
4. Call `client.RegisterMerchant(ctx, RegisterMerchantInput{...})` using
   the same test pubkey/ATA as the Rust example
   (7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT /
    EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK).
5. Fetch it back via `client.GetMerchant`, list with pagination, patch
   the merchant name via `client.UpdateMerchant`.
6. If `ZETTAPAY_SIGNED_TX_BASE64` is set, call `client.Pay(ctx, ...)`
   with the blob in the x402 header. Print txSig on success; print
   `*zettapay.Error` envelope on failure.
7. Best-effort cleanup (delete the registered merchant if a DELETE
   endpoint exists; otherwise no-op with a comment).

Use `context.WithTimeout` for each call. Print structured progress lines
(`"→ ...", "  ..."`) matching the Rust example's UX so devs migrating
between SDKs see identical output.

Build / run commands documented at the top of the file as a Go doc
comment:

  // Run locally:
  //   cd packages/sdk-go && go run ./examples
  //
  // Against a deployed environment:
  //   ZETTAPAY_BASE_URL=https://api.zettapay.dev \
  //   ZETTAPAY_API_KEY=zp_live_... \
  //   cd packages/sdk-go && go run ./examples

Anti-scope:
- Do NOT add `examples/go.mod` — the example must compile under the
  parent `packages/sdk-go/go.mod`. Importing the SDK uses the module
  path `github.com/leandromaiam-code/zettapay/packages/sdk-go`.
- Do NOT introduce a third-party dependency (no `cobra`, no `pflag`,
  no `godotenv`). README claims standard-library-only.
- Do NOT add a Makefile target or shell wrapper.
- Do NOT sign / submit a real Solana transaction inside the example —
  the SDK explicitly does not custody keys. Payment step is skipped
  unless the caller injects a pre-signed base64 blob via env.
- Do NOT include any mention of `wallet.connect`, `window.solana`,
  wallet-adapter, or "Connect Phantom / Wallet / MetaMask" — wallet-less
  HARD rule.

Validation:
1. `cd packages/sdk-go && go build ./...` — example compiles.
2. `cd packages/sdk-go && go vet ./...` — no vet errors.
3. `cd packages/sdk-go && go run ./examples` against `node api/_lib/...`
   (or any local stub) prints the happy-path lines and exits 0 when
   ZETTAPAY_SIGNED_TX_BASE64 is unset (payment step skipped).
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" packages/sdk-go/examples/quickstart.go`
   returns zero matches.
5. `git diff --stat HEAD` shows exactly one file added:
   packages/sdk-go/examples/quickstart.go.

Conflicts:
- None — confirmed by `ls packages/sdk-go/examples 2>&1` returning "No
  such file or directory" on main HEAD (commit 6902c9a). No open PR
  targets packages/sdk-go/examples/.

References:
- Sibling: packages/sdk-rust/examples/quickstart.rs.
- Sibling: packages/sdk-python/examples/quickstart.py.
- Public surface map: packages/sdk-go/client.go (RegisterMerchant,
  GetMerchant, ListMerchants, UpdateMerchant, DeleteMerchant, Pay,
  Health), packages/sdk-go/retry.go (DefaultRetryPolicy),
  packages/sdk-go/types.go (input/output structs).$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 3. public/sitemap.xml — SEO + crawler discoverability for the static frontend
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'public/sitemap.xml — list all 20 static pages for SEO crawlers',
$$Add a `public/sitemap.xml` listing every shipped HTML page so search
engines and AI crawlers can discover the full surface in one fetch.
public/robots.txt already exists (PR #242, UUID 69cdcbce) but currently
has no Sitemap: directive because the sitemap file does not exist.
Premissa 24 (Documentation site critical for adoption) + Premissa 25
(DevRel + open SDK > paid marketing — discoverability is the cheapest
adoption lever).

Scope (1 new file ~70 LOC + 1 file modified +1 line):

(A) Create public/sitemap.xml as a standards-compliant sitemap 0.9 XML
document listing every existing top-level page and /docs/ page. As of
main HEAD (commit 6902c9a) the surface is:

  Top-level:
    /                  (index.html)
    /about             (about.html)
    /pricing           (pricing.html)
    /docs              (docs/index.html)
    /signup            (signup.html)
    /checkout          (checkout.html)
    /pay               (pay.html)
    /dashboard         (dashboard.html)
    /dashboard/payouts (dashboard/payouts.html)
    /contact           (contact.html)
    /launch            (launch.html)
    /status            (status.html)
    /privacy           (privacy.html)
    /terms             (terms.html)

  /docs/* tree:
    /docs/quickstart   (docs/quickstart.html)
    /docs/api          (docs/api.html)
    /docs/embed        (docs/embed.html)
    /docs/webhook      (docs/webhook.html)
    /docs/faucet       (docs/faucet.html)

Each <url> entry should carry:
  - <loc>https://zettapay.dev/<path></loc>
  - <lastmod>2026-05-17</lastmod>   (today, ISO 8601 short form)
  - <changefreq>weekly</changefreq> for /docs/*; <changefreq>monthly</changefreq> for marketing pages.
  - <priority>1.0</priority> for / (index); 0.9 for /docs and /signup;
    0.8 for /pricing, /checkout, /pay, /dashboard; 0.5 for legal pages
    (/privacy, /terms); 0.3 for status / launch.

Do NOT include /404.html (it's the not-found page).

Use the canonical apex domain zettapay.dev to match the existing
robots.txt and the OG meta tags (PR #242).

(B) Append the Sitemap: directive to the END of public/robots.txt
(currently lacks it):

  Sitemap: https://zettapay.dev/sitemap.xml

Append-only; do NOT modify any existing line in robots.txt.

Anti-scope:
- Do NOT generate the sitemap dynamically at build time (no script, no
  workflow). Static XML is faster, simpler, and matches the repo's
  static-frontend posture.
- Do NOT include the API surface (/api/*) — those are not crawlable
  HTML pages.
- Do NOT include /embed.js — that's a script asset, not a page.
- Do NOT include language-specific or localized alternates
  (`<xhtml:link rel="alternate">`) — UI is single-locale today
  (Premissa 27 hints i18n but it is not shipped).
- Do NOT add a sitemap-index file (single sitemap is sufficient under
  the 50k URL / 50 MB sitemap-0.9 limits).

Validation:
1. `xmllint --noout public/sitemap.xml` — well-formed XML (skip if
   xmllint is not on PATH; structural review suffices).
2. Each <loc> URL responds with 200 in Vercel preview deployment:
   `for u in $(grep -oP "(?<=<loc>)[^<]+" public/sitemap.xml); do
     curl -sS -o /dev/null -w "%{http_code} $u\n" "$u";
   done` — every line 200 OK.
3. `cat public/robots.txt | tail -1` shows the new Sitemap: directive.
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" public/sitemap.xml public/robots.txt`
   returns zero matches.
5. `npm run build` untouched (no compile step for public/ static
   assets).
6. `git diff --stat HEAD` shows exactly two changes: 1 file added
   (public/sitemap.xml) + 1 file modified (public/robots.txt).

Conflicts:
- None — confirmed by `ls public/sitemap.xml 2>&1` returning "No such
  file or directory" on main HEAD (commit 6902c9a). robots.txt exists
  (PR #242) and currently has no Sitemap: directive (grep confirmed).
  No open PR targets either path.

References:
- Sitemap 0.9 spec: https://www.sitemaps.org/protocol.html
- Sibling: public/robots.txt (shipped in #242).
- Sibling: public/.well-known/security.txt (queued in #245).$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 4. .github/workflows/wallet-less-gate.yml — CI gate enforcing the HARD rule
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'ci: wallet-less HARD rule grep gate workflow',
$$Add `.github/workflows/wallet-less-gate.yml` that runs on every PR and
push to main, greps the source tree for the banned wallet-connect
strings listed in CLAUDE.md, and fails the workflow on any match.
Today the rule is enforced manually by reviewers and via mission-level
self-check; making it a CI gate prevents drift if a future mission
forgets to grep or a reviewer misses it. Premissa wallet-less HARD rule
(canonical 2026-05-11) + Premissa 31 (build green gate is mandatory).

Scope (1 new file, ~55 LOC):

Create .github/workflows/wallet-less-gate.yml with:

  name: wallet-less gate

  on:
    pull_request:
    push:
      branches: [main]

  jobs:
    grep:
      runs-on: ubuntu-latest
      steps:
        - uses: actions/checkout@v4
        - name: grep for banned wallet-connect strings
          run: |
            set -e
            # The HARD rule (CLAUDE.md) bans these strings in source code.
            # Markdown / docs / mission spec files are excluded because
            # they DOCUMENT the rule and must mention the banned strings.
            PATTERN='wallet\.connect|window\.solana\.connect|window\.ethereum\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect'
            INCLUDE_GLOBS=(
              'packages/sdk/src'
              'packages/sdk-go'
              'packages/sdk-rust/src'
              'packages/sdk-python/zettapay'
              'packages/sdk-php/src'
              'packages/embed/src'
              'packages/widget/src'
              'packages/api/src'
              'api'
              'public'
              'src'
              'scripts'
            )
            EXTENSIONS='\.(ts|tsx|js|jsx|mjs|cjs|html|css|go|rs|py|php)$'
            HITS=0
            for dir in "${INCLUDE_GLOBS[@]}"; do
              [ -d "$dir" ] || continue
              # Use -E for extended regex; --include filters by extension via find.
              MATCHES=$(grep -rEn "$PATTERN" "$dir" \
                --include='*.ts' --include='*.tsx' --include='*.js' --include='*.jsx' \
                --include='*.mjs' --include='*.cjs' --include='*.html' --include='*.css' \
                --include='*.go' --include='*.rs' --include='*.py' --include='*.php' \
                || true)
              if [ -n "$MATCHES" ]; then
                echo "::error::Banned wallet-connect string in $dir:"
                echo "$MATCHES"
                HITS=$((HITS + 1))
              fi
            done
            if [ "$HITS" -gt 0 ]; then
              echo "::error::Wallet-less HARD rule violated. See CLAUDE.md."
              exit 1
            fi
            echo "OK: zero banned wallet-connect strings in source."

Anti-scope:
- Do NOT scan docs/, CLAUDE.md, *.md files, the .github/workflows/
  directory itself, or this companion file — they DOCUMENT the rule and
  must reference the banned strings.
- Do NOT scan node_modules/, dist/, build/, .next/, .vercel/, or any
  vendor folder. The `INCLUDE_GLOBS` allow-list approach above
  intentionally skips them.
- Do NOT add a separate self-hosted runner or a paid CI service — this
  must run on stock `ubuntu-latest`.
- Do NOT add the wallet-less grep to existing workflows (sdk-go.yml,
  npm-publish.yml); ship it as a dedicated job so a single failing
  match does not break unrelated SDK builds.
- Do NOT modify CLAUDE.md or any source file — workflow-only PR.

Validation:
1. Run the grep block locally on main HEAD: copy the script body into
   a shell session and execute. It MUST exit 0 (no current source
   contains the banned strings — verified by the grep audit shipped
   with PR #238 and the ongoing wallet-less refactor #143/#177/#178/
   #187/#220).
2. Push the branch; GitHub Actions starts the `wallet-less gate`
   workflow. Confirm it passes on this PR (zero matches).
3. As a smoke test (do NOT commit), temporarily add a line containing
   `wallet.connect()` to a .ts file under packages/sdk/src/, push, and
   verify the workflow fails with the ::error:: message. Revert and
   re-push before merge.
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" .github/workflows/wallet-less-gate.yml`
   matches multiple lines INSIDE THE WORKFLOW FILE — this is expected
   (the file defines the pattern). The grep gate itself excludes .yml
   from scanning, so the workflow does not self-trip.
5. `git diff --stat HEAD` shows exactly one file added:
   .github/workflows/wallet-less-gate.yml.

Conflicts:
- None — confirmed by `ls .github/workflows/wallet-less-gate.yml 2>&1`
  returning "No such file or directory" on main HEAD (commit 6902c9a).
  Only `npm-publish.yml` and `sdk-go.yml` exist today. No open PR
  targets .github/workflows/.

References:
- HARD rule canon: CLAUDE.md "HARD RULE — WALLET-LESS ARCHITECTURE
  (CANONICAL, 2026-05-11)".
- Prior wallet-less refactor PRs that wiped the source: #143, #177,
  #178, #187, #225, #238.
- Worker memory project_z32_zombie.md: rule is canonical, sentinel chain
  protects retries.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- 5. CONTRIBUTING.md (repo root) — contributor onboarding for the polyglot monorepo
INSERT INTO fabric_squad_missions
  (workspace_id, squad, name, description, phase, status, source, max_retries)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'dev',
   'chore: root CONTRIBUTING.md (open-source contributor onboarding)',
$$Add a repo-root `CONTRIBUTING.md` so first-time external contributors
land in a documented path instead of guessing across five language
ecosystems. Today `packages/sdk-rust/CONTRIBUTING.md` and
`packages/sdk-python/CONTRIBUTING.md` exist but the repo root has none,
and `gh` / GitHub's contributor-discovery UI looks for the root file
first. Premissa 25 (DevRel + open SDK > paid marketing — Stripe /
Vercel / Supabase playbook) + Premissa 31 (open source: protocol spec +
SDKs MIT — contribution path must be public).

Scope (1 new file, ~120 LOC):

Create /CONTRIBUTING.md at the repo root with the following sections
(use ## H2 for each top-level section, ### H3 for sub-sections, no
emojis, no marketing copy, no Claude / Anthropic mention):

1. **Welcome** (3 lines) — One-paragraph framing: ZettaPay is a Solana
   payment protocol for AI agents; contributions to the protocol spec,
   any SDK, the docs site, or the static frontend are welcome.

2. **Code of Conduct** — One line stating contributors agree to the
   Contributor Covenant 2.1; link to https://www.contributor-covenant.org/version/2/1/code_of_conduct/
   (do NOT vendor the full text — link is sufficient).

3. **Wallet-less architecture (HARD rule)** — Reproduce verbatim from
   CLAUDE.md the rule statement: "ZettaPay NUNCA requer conectar
   carteira. Customer apenas FORNECE a chave publica (pubkey/address)."
   List the banned strings (`wallet.connect`, `window.solana.connect`,
   `window.ethereum.connect`, `wallet-adapter-react-ui`, `Connect
   Phantom`, `Connect Wallet`, `Connect MetaMask`, `WalletConnect`).
   Note that the CI gate at `.github/workflows/wallet-less-gate.yml`
   will reject any PR containing them (forward reference is fine —
   if that workflow does not yet exist on merge, link still informs).

4. **Repository layout** — A flat ASCII tree showing the top-level
   directories (api/, packages/, programs/, public/, scripts/, docs/,
   supabase/, audit/, idl/) with one-line purpose each. Reflect actual
   state on main HEAD (commit 6902c9a).

5. **Setup** — Node version (>= 18.18 from package.json), how to clone,
   `npm install`, `npm run build`. Note that `node_modules` is hoisted
   at the root (the symlink convention used in worktrees is internal —
   do not document it externally).

6. **Per-SDK contribution** — A table:
     | SDK | Path | Toolchain | Test command |
     | TypeScript | packages/sdk | Node 18.18+ | `npm test -w @zettapay/sdk` |
     | Go         | packages/sdk-go | Go 1.22+ | `cd packages/sdk-go && go test ./...` |
     | Python     | packages/sdk-python | Python 3.9+ | `cd packages/sdk-python && pytest` |
     | Rust       | packages/sdk-rust | Rust stable | `cd packages/sdk-rust && cargo test` |
     | PHP        | packages/sdk-php | PHP 8.1+ | `cd packages/sdk-php && composer test` |

7. **PR conventions** —
   - Branch naming: `auto/<id>-<slug>` for automated missions; free-form
     for humans.
   - Commit message style: Conventional Commits (`feat`, `fix`, `chore`,
     `docs`, `test`, `ci`, `refactor`). Co-Authored-By is encouraged.
   - One logical change per PR. Keep diffs reviewable.
   - Every PR must include a Test plan checklist.

8. **Build gate** — Every PR runs `npm run build` plus the wallet-less
   gate. Build red blocks merge (Premissa 31).

9. **License** — Contributions are MIT-licensed; submitting a PR signals
   acceptance.

10. **Reporting security issues** — Link to /.well-known/security.txt
    (queued in #245) and the BUG_BOUNTY.md (shipped in #232). Do NOT
    file security bugs as public issues.

Anti-scope:
- Do NOT vendor the full Contributor Covenant text — link is enough.
- Do NOT include a CLA / DCO sign-off requirement — repo is MIT and the
  README does not require either today; introducing one is a separate
  policy decision.
- Do NOT add a CODEOWNERS file in this PR — that is a separate mission
  (deferred per worker memory: "CODEOWNERS needs human owner/team
  decision — not shovel-ready").
- Do NOT add or modify any other root-level doc (README.md, LICENSE,
  CHANGELOG.md). README.md exists; LICENSE exists; CHANGELOG.md does
  not exist and stays out of scope here.
- Do NOT mention Claude / Anthropic / OpenAI / any vendor — Premissa 25
  (no marketing copy) + repo brand discipline.
- Do NOT mention "revolution / disruption / synergy / game-changer" —
  CLAUDE.md brand-voice rule.

Validation:
1. `cat CONTRIBUTING.md | head -1` shows `# Contributing to ZettaPay`.
2. `grep -c "^## " CONTRIBUTING.md` returns 10 (one per top-level
   section above).
3. `grep -E "Claude|Anthropic|OpenAI|revolution|disruption|synergy|game-changer" CONTRIBUTING.md`
   returns zero matches.
4. `grep -E "wallet\.connect|window\.solana\.connect|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask|WalletConnect" CONTRIBUTING.md`
   returns 7+ matches — this is EXPECTED (the doc names the banned
   strings). The wallet-less CI gate excludes `.md` files from scanning,
   so the doc does not self-trip.
5. `npx -y mint@latest broken-links --path .` (best-effort) — no broken
   internal links.
6. `git diff --stat HEAD` shows exactly one file added: CONTRIBUTING.md.

Conflicts:
- None — confirmed by `ls CONTRIBUTING.md 2>&1` returning "No such file
  or directory" on main HEAD (commit 6902c9a). `packages/sdk-rust/CONTRIBUTING.md`
  and `packages/sdk-python/CONTRIBUTING.md` exist and remain canonical
  for those SDKs; the root file is the umbrella entry point only.

References:
- Sibling: packages/sdk-rust/CONTRIBUTING.md.
- Sibling: packages/sdk-python/CONTRIBUTING.md.
- Brand canon: CLAUDE.md "Discipline de código" section.
- Mission-naming canon: CLAUDE.md "AutoDev Cycle" section.$$,
   'execution',
   'pending',
   'auto-regen',
   2);

-- Audit row — auto_regen_executed for this pass
INSERT INTO fabric_audit_journal
  (workspace_id, event_type, payload)
VALUES
  ('c5c5be05-b8e2-4fd7-b85c-6e3e2d00f96b',
   'auto_regen_executed',
   jsonb_build_object(
     'source_mission_uuid_prefix', '9db4cb78',
     'generated_at', '2026-05-17T00:00:00Z',
     'companion_doc', 'docs/discovery/9db4cb78-backlog-refill.md',
     'companion_sql', 'docs/discovery/9db4cb78-backlog-refill.sql',
     'prior_refills', jsonb_build_array(
       jsonb_build_object('pr', 231, 'uuid_prefix', 'fba46358'),
       jsonb_build_object('pr', 242, 'uuid_prefix', '69cdcbce'),
       jsonb_build_object('pr', 244, 'uuid_prefix', '4f79ec06'),
       jsonb_build_object('pr', 245, 'uuid_prefix', '03cf9a17'),
       jsonb_build_object('pr', 251, 'uuid_prefix', '1986ee3d'),
       jsonb_build_object('pr', 252, 'uuid_prefix', 'a82d92db')
     ),
     'missions_inserted', jsonb_build_array(
       'sdk-rust: inline tests for error.rs (is_code + is_status + is_retryable)',
       'sdk-go: examples/quickstart.go (parity with rust/python quickstart)',
       'public/sitemap.xml — list all 20 static pages for SEO crawlers',
       'ci: wallet-less HARD rule grep gate workflow',
       'chore: root CONTRIBUTING.md (open-source contributor onboarding)'
     ),
     'themes', jsonb_build_array(
       'sdk-rust-inline-error-test-parity',
       'sdk-go-examples-parity',
       'seo-sitemap-discoverability',
       'wallet-less-hard-rule-ci-gate',
       'root-contributor-onboarding'
     ),
     'safe_lanes', jsonb_build_array(
       'packages/sdk-rust (additive #[cfg(test)], gated by cargo test)',
       'packages/sdk-go (additive examples/, gated by go build/vet)',
       'public/ (static XML asset, no compile)',
       '.github/workflows/ (CI-only, no source touch)',
       'repo-root (markdown only, no compile)'
     ),
     'avoids', jsonb_build_array(
       'packages/api chronic-broken compile lane',
       'wallet-adapter / wallet.connect code',
       'multi-file refactors of existing source',
       'reformat-the-world sweeps',
       'CODEOWNERS (deferred — needs human owner decision)',
       'public/manifest.json PWA shell (deferred — needs coordinated service worker)',
       'CHANGELOG.md (separate mission, needs version policy decision)',
       'dynamic sitemap generation (static is sufficient)',
       'introducing new third-party deps in any SDK'
     ),
     'known_followups', jsonb_build_array(
       'sdk-python: tests/test__http.py for the transport layer',
       'sdk-python: tests/test_types.py for the dataclass exports',
       'sdk-rust: integration tests for From<reqwest::Error> impls',
       'sdk-go: examples/webhook.go (separate from quickstart)',
       'CODEOWNERS (still deferred — needs human owner/team decision)',
       'public/manifest.json PWA shell (still deferred — needs service worker mission)',
       'CHANGELOG.md per-SDK (each its own mission)',
       'CodeQL static-analysis workflow',
       'license-checker CI workflow',
       'sitemap-index when /docs grows past 50k URLs'
     )
   ));

COMMIT;
