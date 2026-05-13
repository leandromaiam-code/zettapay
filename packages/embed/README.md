# @zettapay/embed

The lean drop-in for ZettaPay. One `<script>` tag renders a QR + pay-to
address. Reads the invoice on-chain via Solana public RPC, polls every
30 s for settlement, and emits a callback when the payment confirms.

- **Bundle:** ~5 KB gzipped, zero runtime dependencies
- **Backend:** none — talks directly to a public Solana RPC
- **Brand:** matches the ZettaPay Forest/Brass/Parchment palette
- **Callbacks:** JS API + `postMessage` for iframe parents + DOM events

Need a full modal + Phantom deeplink + hosted checkout? Use
`@zettapay/widget`. Use `@zettapay/embed` when you want the smallest
possible payload on the merchant site.

## Drop-in (CDN)

```html
<script
  src="https://cdn.jsdelivr.net/npm/@zettapay/embed@latest/dist/embed.js"
  data-recipient="<recipient SPL token account, base58>"
  data-amount="10.50"
  data-reference="<solana-pay reference key, base58>"
  data-cluster="mainnet-beta"
  async
></script>
```

The script auto-discovers itself, reads its dataset, and renders the embed
right after the tag. Multiple tags on one page are supported — each mounts
its own embed.

### Supported `data-*` attributes

| Attribute             | Required | Default                                   | Description                                                              |
| --------------------- | -------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `data-recipient`      | yes      | —                                         | SPL token account (ATA) that receives the funds                          |
| `data-amount`         | yes      | —                                         | Amount in human units (e.g. `10.5`)                                      |
| `data-reference`      | no       | —                                         | Solana Pay reference key — preferred watch address                       |
| `data-mint`           | no       | USDC for cluster                          | SPL mint base58                                                          |
| `data-decimals`       | no       | `6`                                       | Token decimals                                                           |
| `data-cluster`        | no       | `mainnet-beta`                            | `mainnet-beta` or `devnet`. Explicit cluster wins over `data-testnet`.   |
| `data-testnet`        | no       | absent (mainnet)                          | Shortcut flag — `data-testnet="true"` flips the embed to devnet.         |
| `data-rpc-url`        | no       | Public Solana RPC for cluster             | Explicit RPC endpoint                                                    |
| `data-qr-renderer`    | no       | `https://api.qrserver.com/v1/create-qr-code/?size=440x440&data=` | URL prefix the embed appends the encoded payload to            |
| `data-theme`          | no       | `dark`                                    | `dark` or `light`                                                        |
| `data-label`          | no       | —                                         | Memo surfaced in the QR payload                                          |
| `data-poll-interval-ms` | no     | `30000`                                   | Polling cadence (≥ 1000 ms)                                              |

## Programmatic (npm)

```bash
npm install @zettapay/embed
```

```ts
import { mount } from '@zettapay/embed';

const handle = mount(document.querySelector('#checkout')!, {
  recipient: 'ATA_BASE58',
  amount: 24.99,
  reference: 'REF_BASE58',
  cluster: 'mainnet-beta',
  onSuccess: ({ signature, blockTime }) => {
    console.log('paid', signature, blockTime);
  },
});

// Later, e.g. when the merchant's UI navigates away:
handle.destroy();
```

## Cross-frame callbacks

Embedders inside an iframe can listen for `postMessage` events without
depending on the JS API:

```ts
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m?.source !== 'zettapay-embed') return;
  switch (m.type) {
    case 'ready':   /* invoice rendered */ break;
    case 'success': /* m.signature confirmed */ break;
    case 'error':   /* m.code, m.message */ break;
  }
});
```

## Detection details

The embed polls `getSignaturesForAddress` on the watch address every
`pollIntervalMs`. For each novel signature it pulls `getTransaction` with
`jsonParsed` encoding and looks for an SPL `transfer` / `transferChecked`
instruction where the destination equals `recipient` and the amount matches
the invoice. The first match resolves the embed and the poller stops.

When a `reference` is supplied it is the watch address — this is the canonical
Solana Pay flow and gives the cleanest signature stream. Without a reference
the embed watches the recipient ATA directly, which still works but is
noisier on busy accounts.

## Browser support

Chrome 88+, Firefox 86+, Safari 14+, Edge 88+.

## License

MIT — part of the ZettaPay open SDK suite.
