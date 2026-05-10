# @zettapay/widget

Drop-in embed widget for ZettaPay. One `<script>` tag renders a **Pay X USDC**
button. On click, a modal opens with a QR code + Phantom deeplink + checkout
flow that settles in seconds on Solana.

- **Bundle:** ~30 kb gzipped, zero peer deps, no framework lock-in
- **Distribution:** npm (`@zettapay/widget`) + CDN (jsDelivr / unpkg)
- **Brand:** matches the ZettaPay merchant dashboard out of the box
- **Callbacks:** JS API + cross-frame `postMessage` for iframe embedders
- **Fees:** 0.30% per transaction · USDC on Solana · ~2 sec settlement

## Drop-in (CDN)

```html
<script
  src="https://cdn.jsdelivr.net/npm/@zettapay/widget@latest/dist/widget.js"
  data-merchant="@yourshop"
  data-amount="10"
  data-currency="USDC"
  async
></script>
```

The script auto-discovers itself, reads its dataset, and inserts a Pay button
right after the tag. Multiple buttons on one page are supported — each tag
mounts its own button.

### Supported `data-*` attributes

| Attribute        | Required | Default                     | Description                              |
| ---------------- | -------- | --------------------------- | ---------------------------------------- |
| `data-merchant`  | yes      | —                           | Merchant handle (e.g. `@yourshop`)       |
| `data-amount`    | yes      | —                           | Amount in `currency` units               |
| `data-currency`  | no       | `USDC`                      | ISO currency code                        |
| `data-label`     | no       | `Pay {amount} {currency}`   | Button label override                    |
| `data-theme`     | no       | `dark`                      | `dark` or `light`                        |
| `data-api-base`  | no       | `https://api.zettapay.io`   | API root (override for staging / self-host) |
| `data-checkout-base` | no   | `https://pay.zettapay.io`   | Hosted checkout origin used in the QR    |
| `data-metadata`  | no       | —                           | JSON object persisted on the payment     |

## Programmatic (npm)

```bash
npm install @zettapay/widget
```

```ts
import { mount, open } from '@zettapay/widget';

// Render a Pay button into a specific element.
mount(document.querySelector('#checkout')!, {
  merchantId: '@yourshop',
  amount: 24.99,
  onSuccess: ({ paymentId, txSignature }) => {
    console.log('paid', paymentId, txSignature);
  },
});

// Or open the modal directly without rendering a button.
open({ merchantId: '@yourshop', amount: 5 });
```

## postMessage callbacks

Embedders inside an iframe can listen for cross-frame events without depending
on the JS API:

```ts
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.source !== 'zettapay-widget') return;
  switch (m.type) {
    case 'open':    /* paymentId created */ break;
    case 'success': /* m.txSignature */    break;
    case 'cancel':  /* m.reason */          break;
    case 'error':   /* m.code, m.message */ break;
  }
});
```

The `source: 'zettapay-widget'` discriminator lets you filter foreign
postMessage traffic safely.

## Browser support

Chrome 88+, Firefox 86+, Safari 14+, Edge 88+. The widget gracefully degrades
when `clipboard.writeText` is unavailable.

## License

MIT — part of the ZettaPay open SDK suite.
