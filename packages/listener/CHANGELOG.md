# Changelog — @zettapay/listener

## 0.1.2

### Added

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
