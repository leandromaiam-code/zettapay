# Changelog — @zettapay/listener

## 0.6.0

### USDT on Base — second token, same fixed-address pattern (additive)

USDT becomes a SECOND stablecoin on the SAME Base chain that already serves USDC,
in the fixed-address mode (one shared receive address + per-invoice decimal
nonce). USDT on Base is 6 decimals like USDC, so the amount-nonce encoding is
byte-for-byte identical — only the token contract changes. BTC, the USDC xpub
mode and the USDC fixed-address mode are untouched; with no new env var the
listener behaves exactly as in 0.5.0.

- **Multi-token registry (`src/fixed-address-watcher.ts`).** Each EVM chain now
  carries a `tokens[]` list. Base lists `USDC` (default) +
  `USDT 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2`; ethereum/polygon stay
  USDC-only. New helpers: `lookupEvmToken`, `defaultEvmToken`, `parseEvmTokens`.
- **Per-token watcher scan.** `FixedAddressWatcher` runs an independent
  `eth_getLogs` + RPC-quorum pass per enabled token against its OWN contract,
  matching a transfer only to invoices that requested that token. A USDT payment
  never satisfies a USDC invoice and vice versa. The Z76 2-of-N quorum applies to
  each token. Confirmed/orphan webhooks now carry `asset` + `token_address`.
- **`asset` on invoice creation (`src/invoice-core.ts`, `src/http-server.ts`).**
  `POST /invoice {chain:'base', asset:'usdt'}` (default `'usdc'`) persists the
  resolved symbol + token contract, derives the same fixed address + nonce, and
  returns `asset`, `token_address` and a USDT `qr_uri`. USDC and USDT keep
  independent nonce spaces. `asset='usdt'` on a USDC-only chain is rejected.
- **`MERCHANT_EVM_TOKENS` (`src/main.ts`, `src/cli/verify-config.ts`).** Optional
  csv (default `usdc`; e.g. `usdc,usdt`) controlling which tokens the merchant
  accepts on Base. `verify-config` validates it and flags `usdt` without `base`.

## 0.5.0

### Security hardening (additive — zero regression on BTC + USDC paths)

All seven items below are defensive-only. No new paid dependency, no custody, no
KYC, no telemetry, no third-party call: the listener still speaks only to public
RPCs and mempool.space. The full existing test suite passes unchanged.

- **Constant-time API-key auth (`src/http-server.ts`).** The
  `X-ZettaPay-Api-Key` check now uses `crypto.timingSafeEqual` (with a
  length-guard filler) instead of `===`, removing the timing side-channel that
  could leak the key byte-by-byte. Exposed as `timingSafeStrEqual`.
- **RPC quorum for fixed-address confirmations (`src/rpc-quorum.ts`,
  `src/fixed-address-watcher.ts`).** A confirmation now requires a quorum of
  independent public RPCs to AGREE on the same `(tx, value, ≥minConfirmations)`.
  Each chain ships a list of 2–3 public RPCs (base / ethereum / polygon); a
  confirmation only lands when **≥2 agree**. One reachable RPC → invoice stays
  `pending` and we log `rpc_quorum_degraded`; a disagreeing value → no confirm +
  `rpc_quorum_conflict`. A single forging RPC can never decide. A merchant can
  point `BASE_RPC_URL` / `ETHEREUM_RPC_URL` / `POLYGON_RPC_URL` (csv) at their
  own node — a single endpoint collapses the quorum to a trusted source of 1.
- **In-memory rate limit on `POST /invoice` (`src/rate-limit.ts`).** Zero-dep
  sliding window: default 30 req/min per IP + 300/min global, exceed → `429`
  with `Retry-After`. Configurable via `ZETTAPAY_RATE_LIMIT` (`30`, `30,300`, or
  `off`). Denied hits are not counted toward the window.
- **Production guard (`src/main.ts`).** `NODE_ENV=production` with no
  `ZETTAPAY_API_KEY` now REFUSES to boot (an open `POST /invoice` would let
  anyone mint invoices). In dev it only warns. Exposed as `assertApiKeyForEnv`.
- **Deterministic webhook event id (`src/fixed-address-watcher.ts`).**
  `X-ZettaPay-Event-Id` is `sha256(invoice:status)` so a re-detection after a
  restart re-emits the same id and the merchant backend deduplicates. Pull
  reconciliation via `GET /invoice/:id` (returns `tx_hash`).
- **Anti front-running nonce (`src/evm-amount-nonce.ts`,
  `src/invoice-core.ts`).** The fixed-address nonce is now allocated from a
  CSPRNG random origin (`randomNonceStart` via `crypto.randomInt`) walking the
  1..9999 ring, so one invoice's exact amount is not guessable from another.
  Uniqueness within the active `(chain, price)` pool is still guaranteed.
  Under/overpayment remains zero-tolerance → `payment.orphan`.
- **README threat model.** New "Security model & threat model" section documents
  what the listener trusts (public RPC, mitigated by quorum), the xpub vs
  fixed-address privacy trade-off, the own-node recommendation, the prod-guard,
  and the rate limit — honest about guarantees and non-guarantees.

## 0.4.0

### Added

- **USDC fixed-address mode — a second USDC receive path, fully additive.** BTC
  (v0.2.0) and USDC-xpub on Base (v0.3.0) are untouched: their derivation,
  watcher, and webhook paths are byte-for-byte the same and the full existing
  test suite still passes (regression gate). For merchants whose wallet cannot
  export an xpub (Phantom, MetaMask, App Base, Coinbase), a SINGLE fixed receive
  address serves every invoice and the payer is identified by the EXACT amount —
  a per-invoice nonce embedded in the low USDC decimals. Opt-in via
  `MERCHANT_EVM_ADDRESS` (+ optional `MERCHANT_EVM_CHAINS`).
  - `src/evm-amount-nonce.ts` — pure decimal-nonce allocator/encoder/matcher.
    USDC has 6 decimals; the last 4 are reserved as a nonce (1..9999). `$29`
    nonce 42 → `29.000042 USDC`. Max surcharge +0.009999 USDC (~1 cent). Also
    exports the EIP-55 validators (`isValidEvmAddress`, `assertChecksumAddress`).
  - `src/fixed-address-watcher.ts` — scans the ERC-20 `Transfer` event log via
    `eth_getLogs` over a short trailing block window per chain (base / ethereum /
    polygon), matches each inbound transfer's exact value to a pending invoice by
    nonce, and confirms it through the existing HMAC webhook dispatcher. A
    transfer that matches no active invoice emits `payment.orphan` and NEVER
    activates anything. Dedup by `txHash:logIndex`; per-chain `minConfirmations`.
    RPC failures retry on the next tick and never crash the loop.
  - `src/invoice-core.ts` — `createFixedEvmInvoiceForMerchant` allocates the
    smallest free nonce among the merchant's active invoices at the same
    (chain, base price), stores the invoice against the shared fixed address
    (`child_index: null`, 1h TTL so nonces recycle), and returns the EIP-681 QR
    URI. BTC and xpub paths are left completely untouched.
  - HTTP API: `POST /invoice` with `chain: 'base' | 'ethereum' | 'polygon'`
    routes to fixed mode when `MERCHANT_EVM_ADDRESS` is set (xpub mode wins for
    `base` when both are configured). Nonce-pool exhaustion → `503 capacity`.
  - CLI: `init --evm-address <0x..> --evm-chains <csv>` (EIP-55 validated) and
    `verify-config` reports the fixed-address mode + xpub precedence.

### Notes

- If both `MERCHANT_XPUB_EVM` and `MERCHANT_EVM_ADDRESS` target the same chain,
  the xpub mode wins (per-invoice derived address is more secure) and the fixed
  watcher skips that chain with a warning.

## 0.3.0

### Added

- **USDC on Base — a second chain, fully additive.** BTC is untouched: the
  Bitcoin derivation, watcher, and webhook paths are byte-for-byte the same and
  the full existing BTC test suite still passes (regression gate). USDC support
  lives in new, separate files and is opt-in via `MERCHANT_XPUB_EVM`.
  - `src/derive-evm.ts` — derives EIP-55 checksummed `0x` addresses from an
    account-level EVM xpub (`m/44'/60'/0'`) at `m/0/{index}` via
    secp256k1 → keccak256. Matches the canonical Foundry/Hardhat vectors
    (`0xf39Fd6…` at index 0, `0x709979…` at index 1). Refuses xprv/zprv
    (HR-CUSTODY).
  - `src/base-watcher.ts` — polls USDC `balanceOf(address)` on Base via a single
    public RPC (`BASE_RPC_URL`, default `https://mainnet.base.org`), flips
    pending `chain='base'` invoices to `confirmed`, and hands off to the
    existing HMAC webhook dispatcher. RPC failures retry on the next tick and
    never crash the loop.
  - `src/usdc-pricing.ts` — `usdToUsdc` / `formatUsdc` (USDC has 6 decimals,
    1:1 with USD).
- **`POST /invoice` accepts an optional `chain` field** (`'btc' | 'base'`,
  default `'btc'`). Bodies with no `chain` behave exactly as before. With
  `chain: 'base'` and `amount_usd`, it returns a `201` with a checksummed `0x`
  receive address and an EIP-681 payment URI.
- **Conditional Base watcher in `start`.** When `MERCHANT_XPUB_EVM` is set, the
  daemon runs the `BaseWatcher` alongside the BTC listener (shared webhook
  pipeline). Without it, the deployment is BTC-only and identical to before.
- **`init` / `verify-config`** gained optional `MERCHANT_XPUB_EVM` +
  `BASE_RPC_URL` handling. Absent → base disabled, BTC works normally.
- New dependency `@noble/curves` (used only by `derive-evm.ts`).

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
