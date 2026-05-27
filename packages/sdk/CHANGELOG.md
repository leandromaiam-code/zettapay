# Changelog — @zettapay/sdk

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
