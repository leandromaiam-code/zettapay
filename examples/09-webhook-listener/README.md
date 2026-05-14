# 09 · Webhook Listener

A reference webhook receiver that demonstrates the three Stripe-grade
guarantees every production integration should implement:

1. **Signature verification** — HMAC over the raw body with the webhook
   signing secret, constant-time compare.
2. **Idempotency** — a SQLite ledger of processed event ids, so retries
   never double-credit.
3. **Timestamp tolerance** — events older than 5 minutes are rejected to
   blunt replay attacks.

## Flow

```
zettapay ──POST /zettapay/webhook──▶ this server
this server: verify signature → check ledger → 2xx → process async
```

## Run

```bash
npm i express better-sqlite3
ZETTAPAY_WEBHOOK_SECRET=whsec_... npx tsx listener.ts
```

Test:

```bash
curl -X POST localhost:5000/zettapay/webhook \
  -H 'zettapay-signature: t=...,v1=...' \
  -d '{"id":"evt_1","type":"payment.confirmed", ...}'
```

## Why this matters

Webhook bugs eat dollars. A receiver that handles signature, replay and
idempotency in 80 lines is the floor every merchant should clear.
