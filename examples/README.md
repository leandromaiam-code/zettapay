# ZettaPay Sample Apps

Ten reference integrations that show how to accept USDC on Solana through ZettaPay — from a 30-line static HTML drop-in to an AI agent paying autonomously via `x402` + MCP.

All examples honor the protocol rule: **wallet-less checkout**. The customer pays from their own wallet of choice (Phantom, Solflare, hardware, mobile, exchange) by scanning a QR or pasting an address. ZettaPay never asks the browser to open a wallet extension or initiate a wallet handshake.

| # | Folder | What it shows | Stack |
|---|--------|---------------|-------|
| 01 | [`01-solana-pay-clone`](./01-solana-pay-clone) | Bare Solana Pay-style checkout: `solana:` URI + QR + on-chain poll | Node + qrcode |
| 02 | [`02-ai-agent-x402`](./02-ai-agent-x402) | AI agent paying for an API call via `x402` headers | TypeScript + fetch |
| 03 | [`03-shopify-store`](./03-shopify-store) | Drop-in checkout button for a Shopify product page | Liquid + embed.js |
| 04 | [`04-next-storefront`](./04-next-storefront) | Server-rendered Next.js storefront calling `/api/pay/create` | Next.js 16 |
| 05 | [`05-react-embed`](./05-react-embed) | React component wrapping `<zetta-checkout>` web component | Vite + React |
| 06 | [`06-vue-embed`](./06-vue-embed) | Vue 3 component wrapping `<zetta-checkout>` web component | Vite + Vue |
| 07 | [`07-node-sdk-cli`](./07-node-sdk-cli) | CLI that creates a payment intent from the terminal | Node + @zettapay/sdk |
| 08 | [`08-webhook-receiver`](./08-webhook-receiver) | Express receiver with signature verification + idempotency | Node + Express |
| 09 | [`09-mcp-server`](./09-mcp-server) | MCP server exposing ZettaPay as tools for any agent | Node + MCP SDK |
| 10 | [`10-vanilla-html`](./10-vanilla-html) | Zero-build single-file HTML "Pay with USDC" button | HTML |

## Conventions

- Every example reads `ZETTAPAY_API_KEY` from `.env` (use the devnet key from your dashboard).
- Server endpoints default to `https://api.zettapay.dev` — override with `ZETTAPAY_API_BASE`.
- USDC mint is the canonical Solana mint; settlement is direct payer → merchant (no custody).
- Fees: 0.30% per transaction.

## Quickstart

```bash
git clone https://github.com/leandromaiam-code/zettapay
cd zettapay/examples/01-solana-pay-clone
cp .env.example .env  # paste your API key
npm install
npm start
```

## License

MIT. Copy, fork, ship.
