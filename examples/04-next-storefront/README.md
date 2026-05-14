# 04 · Next.js storefront

A Next.js 16 App Router page that creates a payment intent server-side and renders the QR client-side. Shows the recommended pattern for production storefronts:

- The API key never reaches the browser — `/api/checkout` (route handler) calls ZettaPay from the server.
- The client receives only the `intentId` and `uri`.
- The QR + polling is a client component.

## Run

```bash
cp .env.example .env.local
npm install
npm run dev
```

Open http://localhost:3000.

## Files

- `app/page.tsx` — server component listing a single product.
- `app/api/checkout/route.ts` — server-side intent creation.
- `app/components/checkout.tsx` — client QR + poll loop.
