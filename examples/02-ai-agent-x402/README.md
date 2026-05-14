# 02 · AI Agent · x402

An autonomous AI agent that pays a paywalled API using the **x402 header
protocol**. The agent holds its own keypair, fetches the resource, sees a
`402 Payment Required` response with a payment quote, signs the transfer,
and retries the request with an `X-PAYMENT` header.

## Flow

```
agent ──GET /premium-feed──▶ server
                            ◀── 402 + x-payment-required JSON
agent ──signs USDC tx────▶ chain (devnet)
agent ──GET + X-PAYMENT──▶ server
                            ◀── 200 + content
```

The agent never holds a long-lived session and never connects a UI wallet —
it owns a keypair file at `~/.zettapay/agent.json` and signs transactions
directly with `@solana/web3.js`.

## Run

```bash
npm i @solana/web3.js @solana/spl-token undici
ZETTAPAY_API=https://zettapay.vercel.app npx tsx agent.ts
```

## Why this matters

This is the canonical pattern for **agentic commerce**. An LLM tool-call
returns a 402; the agent reasons about the cost, decides to pay, and the
payment is finished before the next inference step. There is no chat-bubble
"please connect your wallet" — that experience is dead for agents.
