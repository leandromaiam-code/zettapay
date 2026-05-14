# 01 · Solana Pay Clone

Minimal Solana Pay-style checkout. Generates a `solana:` URI from a payment intent, renders a QR, and polls the chain until the transfer lands.

No wallet connect, no SDK lock-in — this is the canonical primitive that every ZettaPay integration sits on top of.

## Run

```bash
cp .env.example .env
npm install
npm start
```

Open the QR shown in the terminal with any Solana wallet (Phantom, Solflare, mobile exchange app) and pay.

## What you'll see

1. `POST /v1/pay/create` returns an `intentId` and a `solana:` URI.
2. We render the URI as a QR in the terminal.
3. We poll `GET /v1/pay/:intentId` every 3s until status flips to `settled`.

## Files

- `index.mjs` — 60 lines of plain Node, no framework.
- `.env.example` — paste your devnet API key here.
