# 07 · Node SDK CLI

A tiny terminal tool that uses `@zettapay/sdk` to create payment intents and stream their status. Use it as a payments terminal for in-person sales, support refunds, or quick ad-hoc invoices.

## Run

```bash
cp .env.example .env
npm install
npm start -- create 25.00 "Invoice #123"
npm start -- status pi_abc123
```

## Commands

- `create <amount> [reference]` — create an intent and print the `solana:` URI.
- `status <intentId>` — print current status.
- `watch <intentId>` — poll every 3s until settled or expired.
