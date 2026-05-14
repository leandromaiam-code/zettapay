# 02 · AI Agent paying via x402

Shows how an autonomous AI agent settles a paywalled API call using the `x402` header protocol.

The flow:
1. Agent calls a paywalled endpoint without payment.
2. Server responds `402 Payment Required` with a `WWW-Authenticate: x402 ...` challenge.
3. Agent signs a USDC transfer offline (its own keypair), encodes the tx, and retries with `X-Payment: x402 <base64-tx>`.
4. Server submits the transaction, verifies settlement, returns the protected resource.

This sample skips key management — for production, agents should use a dedicated hot wallet with capped balance and a separate signer service.

## Run

```bash
cp .env.example .env
npm install
npm start
```

You'll see two halves of the conversation: the unpriced request (402) and the priced retry (200).

## Files

- `agent.mjs` — the agent that pays.
- `paywalled-server.mjs` — a local Express stub that returns 402 then 200.
- `.env.example` — devnet keypair + USDC mint.
