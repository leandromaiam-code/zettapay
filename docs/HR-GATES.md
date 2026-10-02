# Hard Rule (HR-*) Gates

Live invariants enforced on every spec, every PR, and every merged commit.

> **Where the implementation lives:** `fabric/` (Fabric host) and
> `.github/workflows/hr-scan.yml` + `scripts/hr-scan.mjs` (this repo).
> See `fabric/README.md` for architecture and `fabric/server-patch.md` for
> deployment.

## The ZettaPay Hard Rules

Seven rules live in `fabric/seed/zettapay_hrs.json`. The first four are product
invariants; the last three protect the self-hosted listener.

### HR-CUSTODY — Non-custodial invariant (severity: **hard**)

ZettaPay never possesses, generates, stores, or has capacity to sign with
private keys controlling merchant or customer funds.

Forbidden:
- Storing private keys (`PRIVATE_KEY`, `MASTER_SEED`, `TREASURY_*KEY`)
- Deriving addresses from a ZettaPay-held master seed
- Signing transactions on behalf of merchants (`KeyManager.sign*`,
  `privateKeyToAccount(...)`, `createWalletClient(...)`)
- "Sweep cron" services that consolidate merchant funds using our keys

Allowed:
- Merchant-supplied **xpub**, ZettaPay derives child addresses (BIP-44 / BIP-84)
- Customer signs in their own wallet (Phantom / MetaMask / hardware / etc.)
- Read-only on-chain queries (watch addresses, parse confirmations)

### HR-WALLET-LESS — Merchant never connects a wallet (severity: **hard**)

Merchant onboarding and dashboard use email + address inputs only. Customers
use whatever wallet they like — that is fine — but ZettaPay UI never calls
`wallet.connect()`, `window.solana.connect()`, `window.ethereum.request(...)`,
nor imports `@solana/wallet-adapter`.

Allowed: offline `signMessage` for dashboard auth (paste hex), Solana Pay
URI generation, `wallet-standard` for detection-only reads.

### HR-PII-MINIMAL — Minimal PII collection (severity: **hard**)

Onboarding collects only email + shop_name. No `ssn`, `tax_id`, `passport`,
`social_security`, birthdate, address, full name. KYC is allowed **only** as
the feature-gated MoonPay-style threshold path (paths under `kyc/` and
`sumsub/` are allowlisted as the canonical implementation).

### HR-SECRETS-IN-GIT — No real secrets committed (severity: **blocker**)

Live API keys, private keys, webhook secrets never land in git. Placeholder
patterns in `.env.example` are fine; the scanner heuristically skips
low-entropy / all-repeating placeholders.

Detection: `sk_live_*`, `zk_live_*`, `whsec_*`, `ghp_*`, raw 64-hex (`0x…`)
followed by EOL or comment.

### HR-PHONE-HOME — The self-hosted listener never phones home (severity: **hard**)

`@zettapay/listener` makes no outbound request to a ZettaPay-controlled domain.
Allowed traffic: the chain data sources, the merchant's own webhook URL, and the
merchant's own database when a Supabase/Postgres adapter is chosen. In practice
the scanner flags any hard-coded ZettaPay URL in shipped code or public pages —
use configuration or relative links.

### HR-OPTIONAL-DEPS — Storage adapters are optional peer dependencies (severity: **hard**)

The listener installs and runs with zero database drivers. A storage backend's
driver is an optional peer dependency, loaded only when that adapter is selected.

### HR-STORAGE-ADAPTER — All listener persistence goes through `StorageAdapter` (severity: **hard**)

No direct file or database access for merchant, invoice or webhook state outside
an adapter implementation.

## The 4 gates

| # | When | What runs | On violation |
|---|---|---|---|
| 1 | Pre-dispatch (Fabric) | `preflightCheck(mission)` — LLM judge + `selfHealSpec()` retry ×3 | `412 preflight_hr_violation`, audit journal |
| 2 | Pre-merge (this repo) | `hr-scan` GitHub Action runs `scripts/hr-scan.mjs diff` | PR check fails with file:line annotations |
| 3 | Post-merge (Fabric host) | `fabric-hr-postscan.timer` → `bin/postscan.js` (hourly) | auto-revert PR + audit journal + WhatsApp ping |
| 4 | Learning (Fabric host) | `fabric-hr-learning.timer` → `bin/hr-learning.js` (daily) | proposes new `severity=soft` HRs from recurring violations |

> **Status (2026-10):** gates 1 and 2 are live. Gates 3 and 4 are designed
> (`fabric/systemd/`, `fabric/bin/`) but their timers are **not installed** on the
> Fabric host — today nothing reverts a violation after merge, so gate 2 is the
> last line of defence.
>
> `node scripts/hr-scan.mjs tree` is **not** clean on `main`: the pre-pivot code
> (`packages/api`, plugins, the non-published SDKs) still carries violations that
> predate the rules. The PR gate only checks added lines.

## How the PR gate works

`scripts/hr-scan.mjs diff origin/main` runs in CI on every PR. It:

1. Loads HR rules from `fabric/seed/zettapay_hrs.json` (mirror of Postgres).
2. Reads `git diff --unified=0 origin/main...HEAD`.
3. For every `+` line (added content), runs each rule's regex.
4. Skips paths under `docs/`, `examples/`, `scripts/`, `fabric/`,
   `audit/`, `community/`, `public/install/`, `packages/legacy-solana/`,
   `kyc/`, `sumsub/`, `.env.example`, all `*.md`/`*.mdx`/`*.test.*`/`*.spec.*`
   files, and any `tests/` or `__tests__/` directory.
5. Skips `HR-SECRETS-IN-GIT` matches that look like placeholders
   (low-entropy / repeating chars).
6. Emits `::error file=...,line=...::HR-X (severity)…` annotations.
7. Exits non-zero on any `hard` (1) or `blocker` (2) violation.

## Overriding

PR label `hr-override:HR-CUSTODY` propagates into `ALLOW_HR_OVERRIDE` env for
the scan. Hard violations can be overridden with a label. **Blocker
violations cannot** — if you genuinely need to override a `whsec_…` real
secret, demote the rule to `hard` first (and explain why in the PR
description).

## Running locally

```bash
# Scan only what your branch added vs origin/main
node scripts/hr-scan.mjs diff

# Scan specific files
node scripts/hr-scan.mjs files packages/api/src/services/foo.ts

# Scan entire repo (for spring-cleaning / triage)
node scripts/hr-scan.mjs tree
```

Exit codes: `0` clean (or soft-only), `1` hard violation, `2` blocker.

## Adding a new rule

Two paths:

1. **For ZettaPay specifically:** add to `fabric/seed/zettapay_hrs.json`
   (used by this repo's scanner) and to `fabric/seed/zettapay_hrs.sql`
   (used by Fabric's preflight). Submit a PR — the scanner will validate
   itself against the new rule.
2. **System-wide:** insert via Fabric admin into
   `fabric_layer0_premissas` with `premissa_kind='HR'`. The learning
   cron may also propose new soft HRs automatically.
