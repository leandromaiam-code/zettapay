# ZettaPay Examples

Ten end-to-end sample apps that demonstrate every supported integration path
for ZettaPay — from a minimal Solana Pay clone to a full AI-agent stack using
x402 + MCP.

Every example follows the **wallet-less architecture**: the customer pastes a
public key or scans a QR with a wallet of their choice. No `wallet.connect()`
call appears anywhere in this directory.

| # | Example | What it shows | Files |
|---|---------|---------------|-------|
| 01 | [`solana-pay-qr`](./01-solana-pay-qr) | Solana Pay URI + QR generation, on-chain polling. | `index.ts`, `README.md` |
| 02 | [`ai-agent-x402`](./02-ai-agent-x402) | Autonomous AI agent paying through the x402 header protocol. | `agent.ts`, `README.md` |
| 03 | [`shopify-store`](./03-shopify-store) | Shopify storefront accepting USDC via ZettaPay webhooks. | `webhook.ts`, `README.md` |
| 04 | [`express-checkout`](./04-express-checkout) | Node + Express merchant integration with `@zettapay/sdk`. | `server.ts`, `README.md` |
| 05 | [`nextjs-storefront`](./05-nextjs-storefront) | Next.js App Router storefront, server-rendered QR. | `page.tsx`, `route.ts`, `README.md` |
| 06 | [`discord-tip-bot`](./06-discord-tip-bot) | Discord bot for community USDC tipping. | `bot.ts`, `README.md` |
| 07 | [`mcp-server`](./07-mcp-server) | MCP server exposing `zettapay.pay` as a tool callable by any LLM. | `server.ts`, `README.md` |
| 08 | [`react-widget`](./08-react-widget) | React SPA embedding `@zettapay/embed`. | `App.tsx`, `README.md` |
| 09 | [`webhook-listener`](./09-webhook-listener) | Reference webhook receiver with HMAC verification and idempotency. | `listener.ts`, `README.md` |
| 10 | [`subscription-billing`](./10-subscription-billing) | Memo-based recurring billing for monthly subscribers. | `billing.ts`, `README.md` |

## Run

Each example is self-contained. Open the example folder and follow its
`README.md`. They are written to be copy-pasted into new repositories, so they
do not share `package.json` files or workspace links with the main monorepo.

## Wallet-less guarantee

Run the verification grep over this directory before committing any changes:

```bash
grep -RE "wallet\.connect\(|window\.solana\.connect\(|wallet-adapter-react-ui|Connect Phantom|Connect Wallet|Connect MetaMask" examples/
# must return zero matches
```

## License

MIT. See [`../LICENSE`](../LICENSE).
