# ZettaPay

Open-source universal payment protocol on Solana for humans and AI agents.

## Tech Stack
- Node.js + Express + TypeScript
- @solana/web3.js + @solana/spl-token
- Solana devnet (USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`)

## Setup
```bash
npm install
cp .env.example .env   # fill SOLANA_FEE_PAYER_SECRET
npm run dev
```

## Endpoints

### `POST /merchants/register`
Receives a Phantom wallet pubkey, creates the merchant's USDC ATA on
devnet (rent ~0.002 SOL paid by the protocol fee payer) and emits a
memo program transaction binding the merchant id to the wallet on-chain.

Request:
```json
{ "name": "Café Tatuapé", "email": "lojista@tatuape.com.br", "walletAddress": "<phantom-pubkey>" }
```

Response (201):
```json
{
  "merchant": { "id": "...", "walletAddress": "...", "ataAddress": "...", "status": "active" },
  "binding": {
    "ataAddress": "...",
    "ataCreated": true,
    "txSignature": "...",
    "memoPayload": "{\"ns\":\"zettapay:merchant_register:v1\",...}",
    "feePayer": "...",
    "cluster": "devnet"
  },
  "apiKey": "zp_live_..."
}
```

## Features
- Merchant onboarding via Phantom wallet
- USDC P2P payments
- MoonPay onramp (card → USDC)
- x402 header support
- MCP endpoint for AI agents
