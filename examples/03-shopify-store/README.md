# 03 · Shopify Store integration

Drop-in "Pay with USDC" button for a Shopify product page. Renders inside the existing checkout flow — customer scans the QR with their wallet, your store gets a `payment_confirmed` webhook, ZettaPay marks the Shopify order as paid.

No app install, no wallet connect. Two files: the Liquid snippet that mounts the widget, and a tiny Node webhook receiver that flips the Shopify order to `paid` once settlement lands.

## Install the snippet

1. In your Shopify admin, open **Online Store → Themes → Edit code**.
2. Create a new snippet `zettapay-button.liquid` and paste the contents of [`zettapay-button.liquid`](./zettapay-button.liquid).
3. In `product.liquid` (or your buy-button section), include the snippet:
   ```liquid
   {% render 'zettapay-button', product: product %}
   ```
4. In **Settings → Notifications → Webhooks**, point `Order created` at your webhook receiver.

## Run the webhook receiver

```bash
cd webhook
cp .env.example .env
npm install
npm start
```

Use `ngrok http 4242` for a public URL while developing.

## Files

- `zettapay-button.liquid` — the storefront snippet.
- `webhook/server.mjs` — Express receiver that marks orders paid.
