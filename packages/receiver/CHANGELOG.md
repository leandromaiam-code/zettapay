# Changelog — @zettapay/receiver

## 0.1.3

### Changed

- Version aligned to the workspace matrix tagged for the Z67 cut. Pairs
  with `@zettapay/listener` 0.1.3 — same HMAC envelope contract, no
  protocol changes. Reusable as the verifier in the listener's
  "test before mainnet" signet walkthrough.

## 0.1.2

- Initial publish: standalone HMAC-verifying CLI + `classifyWebhookUrl`
  helper shared with the listener dispatcher. Allows
  `http://localhost` / `http://127.0.0.1` / `http://[::1]` as a
  documented dev exception to the otherwise-mandatory HTTPS webhook
  policy.
