# 03 · Shopify Store

Reference webhook receiver that turns a Shopify `orders/create` event into a
ZettaPay payment intent. The customer is redirected to a hosted ZettaPay
checkout page; on confirmation, the store's order is marked paid via the
Shopify Admin API.

## Flow

```
shopify ──orders/create webhook──▶ this server
this server ──POST /payments──▶ zettapay api
              ◀── { paymentUrl, reference }
this server stores reference ↔ shopify_order_id
zettapay ──webhook payment.confirmed──▶ this server
this server ──PUT /admin/orders/<id>/transactions──▶ shopify
```

## Run

```bash
npm i express @zettapay/sdk crypto-js
SHOPIFY_SHARED_SECRET=shpss_... \
SHOPIFY_ADMIN_TOKEN=shpat_... \
ZETTAPAY_API_KEY=zp_live_... \
npx tsx webhook.ts
```

Set the ngrok / Vercel URL as the destination in
`Settings → Notifications → Webhooks → orders/create` in the Shopify admin.

## Why this matters

Shopify is the canonical e-commerce surface. Showing the protocol working
end-to-end with HMAC verification and order reconciliation is enough to
unlock the long tail of "I have a Shopify store and I want USDC".
