# @zettapay/api

Express service that owns the ZettaPay backend's Solana connection. Provides:

- A retrying [`SolanaConnectionService`](src/lib/solana.ts) with exponential backoff for transient RPC errors.
- A [faucet helper](src/lib/faucet.ts) that issues devnet/testnet airdrops and waits for confirmation.
- HTTP routes for `/health`, `/health/solana`, and `/faucet/airdrop`.

## Environment

Configured entirely via env vars (see root `.env.example`):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP port |
| `SOLANA_NETWORK` | `devnet` | `devnet`, `testnet`, or `mainnet-beta` |
| `SOLANA_RPC_URL` | `https://api.devnet.solana.com` | Override the RPC endpoint |
| `RPC_MAX_RETRIES` | `5` | Maximum retries per RPC call |
| `RPC_INITIAL_BACKOFF_MS` | `250` | Starting backoff delay |
| `RPC_MAX_BACKOFF_MS` | `4000` | Cap on a single backoff delay |
| `FAUCET_MAX_AIRDROP_LAMPORTS` | `2000000000` | Hard cap per airdrop (defense in depth) |

The faucet route returns `409` when `SOLANA_NETWORK=mainnet-beta`.

## Scripts

```bash
npm run build     # tsc -> dist/
npm run typecheck # tsc --noEmit
npm run dev       # tsx watch
npm start         # node dist/index.js
```

## HTTP

```bash
curl http://localhost:3001/health
curl http://localhost:3001/health/solana
curl -X POST http://localhost:3001/faucet/airdrop \
  -H 'content-type: application/json' \
  -d '{"recipient":"<base58 pubkey>","lamports":1000000000}'
```
