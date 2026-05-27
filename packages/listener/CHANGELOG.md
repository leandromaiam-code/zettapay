# Changelog — @zettapay/listener

## 0.1.5

### Fixed

- **`init` honors the `localhost-http` webhook policy (regression from
  Z65).** `cli/init.ts` was still gating webhook URLs with a strict
  `isHttpsUrl` check, so `--webhook-url http://127.0.0.1:9876/webhook`
  was rejected by `init` even though the dispatcher and `verify-config`
  had already adopted the shared `classifyWebhookUrl` policy that allows
  `http://localhost` / `http://127.0.0.1` / `http://[::1]` for local
  `@zettapay/receiver` integration. `init` now uses
  `isAllowedWebhookUrl`, surfaces a DEV MODE warning for the localhost
  carve-out, and rejects public-host plain http with the underlying
  policy reason.

## 0.1.3

### Added

- **Signet + testnet + regtest support.** New `MERCHANT_NETWORK` env var
  (and `--network` flag on `init` / `derive-address`) routes the watcher
  to the corresponding `mempool.space` cluster (`mempool.space`,
  `mempool.space/testnet`, `mempool.space/signet`) and picks the right
  bech32 prefix (`bc1` / `tb1` / `bcrt1`). The codepath is the same as
  mainnet — merchants can prove the full pipeline end-to-end against
  zero-value coins before flipping to mainnet.
- **Network ↔ xpub guard.** `verify-config` + `init` + `derive-address`
  refuse mismatched combinations (e.g. a mainnet `zpub` with
  `--network signet`, or a `vpub` with `--network mainnet`).
- **README section "Testing before mainnet".** Copy-pasteable signet
  walkthrough: Sparrow → init → receiver → faucet → confirmed webhook.
- **Automated CI test gate.** A new `.github/workflows/test.yml` runs
  `npm test --workspaces` on every PR. Tests cover BIP-84 official
  vectors, HMAC sign/verify roundtrip (listener ↔ receiver), end-to-end
  invoice lifecycle against a stubbed `mempool.space` surface, and
  storage atomicity under 500 parallel `nextChildIndex` callers.

### Changed

- `MERCHANT_NETWORK` is now persisted by `init` (previously it inferred
  from the xpub at boot). Run `zettapay-listener verify-config` after
  upgrading.

## 0.1.2

### Added

- Workspace version alignment with `@zettapay/sdk`, `@zettapay/widget`, and
  `@zettapay/embed` — the `v0.1.2` tag now publishes all four packages
  together. See `packages/sdk/CHANGELOG.md` for the new
  `@zettapay/sdk/server` webhook verifier merchants pair with the listener.
- **`http://localhost` webhook exception.** `MERCHANT_WEBHOOK_URL` now
  accepts `http://localhost`, `http://127.0.0.1`, and `http://[::1]` in
  addition to the standard `https://` requirement. Everything else
  remains rejected. Pairs with `@zettapay/receiver` for local
  integration testing. The listener prints a single boot-time warning
  when running in dev-mode HTTP: `DEV MODE: webhook over plain http
  allowed for localhost. Use https for production.`

## 0.1.1

### Fixed

- **CLI bin shim now actually runs subcommands.** Under `npm i -g`, the
  generated `zettapay-listener` shim is a symlink to `dist/main.js` —
  `process.argv[1]` resolves to the symlink path, so the previous
  `argv[1].endsWith('main.js')` heuristic missed every global install
  and `init` / `start` / `migrate` silently exited 0 without doing
  anything. `invokedAsScript()` now compares the realpath of
  `argv[1]` against `fileURLToPath(import.meta.url)`, with belt-and-
  suspenders suffix fallbacks for esbuild bundles and Windows shims.
- **Top-level `--help` / `--version` / `help` print output.** Previously
  these fell through to the `start` branch and read `MERCHANT_WEBHOOK_URL`
  — useless on a fresh box. They now resolve immediately, in front of
  `.env` loading.
- **Subcommand promises are properly awaited** in the dispatcher; the
  exit code is propagated via `process.exitCode` so stdout/stderr flush
  before the process tears down.

### Added

- **`zettapay-listener derive-address`** — derive a BIP-84 receive
  address from the merchant xpub. Read-only; never increments
  `next_child_index`. Optional `--index <n>` and `--xpub <override>`
  flags.
- **`zettapay-listener create-invoice --amount-sats <N> [--memo s]`** —
  atomically allocates the next child index, derives its bech32
  address, persists a pending invoice via the configured
  `StorageAdapter`, and prints a BIP-21 URI suitable for a QR code.
  Honours `--expires-in <seconds>` (default 3600).
- BIP-84 derivation (`@scure/bip32` + `@scure/base` + `@noble/hashes`)
  is now a runtime dependency — the listener is fully self-sufficient
  for the merchant MVP flow without needing the SDK.

### Notes

- No breaking API changes; storage schema unchanged.
- `HR-CUSTODY`, `HR-WALLET-LESS`, `HR-STORAGE-ADAPTER`, `HR-PHONE-HOME`
  all preserved (derivation is local-only crypto; no new outbound calls).

## 0.1.0

- Initial publish (Z61 / Z63): @zettapay/listener daemon + Dockerfile,
  CLI surface `init / start / verify-config / healthcheck / migrate`,
  storage adapters `json` (default) and `sqlite` (tier-2 peer dep),
  webhook dispatcher + health server.
