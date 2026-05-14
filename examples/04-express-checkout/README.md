# 04 · Express Checkout

Minimal Node + Express merchant integration using `@zettapay/sdk`. Exposes a
`POST /checkout` endpoint that creates a payment intent and returns a hosted
checkout URL.

## Flow

```
client ──POST /checkout──▶ this server
this server ──sdk.payments.create──▶ zettapay api
this server ◀── { paymentUrl, reference }
client redirected to paymentUrl
```

## Run

```bash
npm i express @zettapay/sdk
ZETTAPAY_API_KEY=zp_live_... npx tsx server.ts
curl -X POST localhost:3000/checkout -H 'content-type: application/json' \
     -d '{"amount":"10.00","sku":"book-001"}'
```

## Why this matters

This is the smallest possible merchant footprint. Replace Stripe SDK calls
with ZettaPay SDK calls. Settlement is instant; fees are a fraction.
