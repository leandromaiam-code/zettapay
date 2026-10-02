# Changelog — @zettapay/sdk

## 0.2.0

### Added

- **`@zettapay/sdk/api`** — `ZettaPayApi`, a dependency-free client for the
  current HTTP API of the self-hosted listener (`/invoice`, `/health`) and of
  ZettaPay Cloud (same routes under `/api/v1`): `createBtcInvoice`,
  `createBaseInvoice` (USDC / USDT), `getInvoice`, `health`. The route prefix
  comes from the required `target` option. Typed errors: `ZettaPayApiError`,
  `PlanLimitReachedError` (402 `plan_limit_reached`), `RateLimitedError` (429).
- **`@zettapay/sdk/webhooks`** — `verifyWebhook`, matching what the dispatcher
  sends: hex HMAC-SHA256 over the raw body, `X-ZettaPay-Timestamp` in
  milliseconds, flat `{ event, ... }` payloads (`invoice.confirmed`,
  `payment.orphan`). Also exported from `@zettapay/sdk/server` and the root.

### Deprecated

- `ZettaPayClient`, `InvoicesResource`, `parseWebhook`,
  `verifyWebhookSignature`, `parseEvent`, `ZettaPayEventSchema` and the Solana
  helpers. They target the pre-pivot API and do not work against the current
  listener or Cloud. Still exported; no behaviour change.

## 0.1.3

### Changed

- Version aligned to the workspace matrix tagged for the Z67 cut. Pairs
  with `@zettapay/listener` 0.1.3 — no API changes, same webhook
  verifier surface as 0.1.2.

## 0.1.2

### Added

- **`@zettapay/sdk/server` entry point.** Node-only export surface for
  merchant backends. Ships `verifyWebhookSignature(payload, signature,
  timestamp, secret, opts?)`, a timing-safe HMAC verifier with replay
  protection (5-minute tolerance by default), and `parseEvent(raw)` for the
  pre-verified path. Both return a typed `ZettaPayEvent` discriminated
  union (`invoice.confirmed`, `invoice.pending`, `invoice.expired`,
  `invoice.underpaid`).
- `WebhookSignatureError` with a stable `code` field
  (`invalid_signature` | `timestamp_too_old` | `malformed`) so merchants
  can branch on failure mode.
- README section "Receiving webhooks" with copy-pasteable Next.js (App
  Router) and Express examples.

### Changed

- **Version aligned to the workspace matrix.** Bumped from `2.0.0` →
  `0.1.2` so the `v0.1.2` tag publishes `@zettapay/sdk`,
  `@zettapay/widget`, `@zettapay/embed`, and `@zettapay/listener`
  together. No functional change to the existing exports.

### Dependencies

- Added `zod ^3.23.8` (runtime — used by the server event parser; already
  present transitively via `@zettapay/listener`).
