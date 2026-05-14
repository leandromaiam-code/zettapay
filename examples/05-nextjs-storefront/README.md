# 05 · Next.js Storefront

A Next.js App Router storefront that server-renders a Solana Pay QR for a
product page. The QR is generated on the server with `@solana/pay` and
served as an inline data URL — no client wallet adapter, no `use client`
hydration cost.

## Flow

```
GET /shop/<sku> (RSC)
  └── server builds payment URL → renders <img src="data:image/png;base64,...">
GET /api/payments/<reference>/status
  └── server polls solana RPC → returns { confirmed: boolean, signature?: string }
client polls the status endpoint every 2s until confirmed
```

## Run

```bash
npx create-next-app@latest my-store --typescript --app
cp page.tsx my-store/app/shop/[sku]/page.tsx
cp route.ts my-store/app/api/payments/[reference]/status/route.ts
cd my-store
npm i @solana/pay @solana/web3.js qrcode
npm run dev
```

Open `http://localhost:3000/shop/book-001`.

## Why this matters

Next.js is the de-facto stack for production React storefronts. This is the
minimal proof that a wallet-less checkout works inside an RSC tree with no
client JS beyond a polling fetch.
