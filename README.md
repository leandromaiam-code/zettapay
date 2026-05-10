# ZettaPay

Open-source universal payment protocol on Solana for humans and AI agents.

## Live deployment

| Environment | URL |
| --- | --- |
| Production (Vercel) | https://zettapay.vercel.app |
| Custom domain | https://zettapay.fabric.4profitai.com |
| Documentation | https://docs.zettapay.io |

Quick checks:

```bash
curl https://zettapay.vercel.app/healthz
curl https://zettapay.vercel.app/simulate/test-merchant
```

## Tech Stack
- Node.js + Express + TypeScript (long-running server)
- Vercel Serverless Functions (`/api/*`) for the public preview
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

### `GET /simulate/:merchant`
Hackathon demo simulator. Returns a deterministic synthetic merchant plus
a fake airdrop and payment, with no on-chain side effects. Available on
Vercel as a serverless function and on the local Express server.

```bash
curl https://zettapay.vercel.app/simulate/test-merchant
```

## Features
- Merchant onboarding via Phantom wallet
- USDC P2P payments
- MoonPay onramp (card → USDC)
- x402 header support
- MCP endpoint for AI agents

## Vercel deployment

The project ships with a thin `/api/*` serverless layer that mirrors the
public-facing routes of the Express server. It is independent of the
SQLite-backed long-running runtime, so it runs cleanly on Vercel without
native modules or persistent storage.

```
api/
├── index.ts                # GET /api      → metadata
├── healthz.ts              # GET /healthz  → liveness
├── simulate/[merchant].ts  # GET /simulate/:merchant → demo simulator
└── _lib/                   # shared helpers (base58, …)
```

Routing:

- `vercel.json#rewrites` exposes `/healthz` and `/simulate/:merchant` at the
  root, matching the Express route shape.
- Every function uses 1 GB RAM and a 30 s `maxDuration` budget.
- The build command is a no-op — Vercel auto-detects the `api/**/*.ts` functions
  and compiles them with its bundled `@vercel/node` runtime.

Local emulation:

```bash
npx vercel dev
curl http://localhost:3000/healthz
curl http://localhost:3000/simulate/test-merchant
```

## Documentation site

The public docs at [docs.zettapay.io](https://docs.zettapay.io) live in
[`docs/`](./docs) and are rendered by [Mintlify](https://mintlify.com).
Mintlify builds directly from the `main` branch — there is no Vercel
build for the docs site.

```bash
npm run docs:dev      # local preview at http://localhost:3000
npm run docs:check    # validate links and references
```

See [`docs/README.md`](./docs/README.md) for the full structure and
Algolia DocSearch configuration.

## Docker

Multi-stage `node:20-alpine` image. The runtime stage runs as non-root, exposes
port `3001` and ships a Node-based `HEALTHCHECK` against `/healthz`.

```bash
cp .env.example .env
docker compose up --build
curl http://localhost:3001/healthz
```

SQLite state is persisted in the named volume `zettapay-data` (mounted at
`/app/data` inside the container).

## Security and audit

Per ZettaPay constitution rules 16, 18 and 19, mainnet launch is gated
on a third-party audit of the on-chain program (OtterSec or Halborn)
plus a public bug bounty.

The audit submission package lives in [`audit/`](./audit) and contains
the threat model, scope, security assumptions, self-disclosed known
issues, the parallel $50k bug bounty terms, and the engagement
logistics for the audit firm. The on-chain program itself is in
[`programs/zettapay/src/lib.rs`](./programs/zettapay/src/lib.rs).

Vulnerability disclosures: `security@zettapay.io`. Public bounty
program details: [`audit/BUG_BOUNTY.md`](./audit/BUG_BOUNTY.md).
