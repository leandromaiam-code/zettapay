# 01 · Solana Pay QR

A minimal Solana Pay clone. Generates a `solana:` payment URI for a merchant
address + amount, renders the QR code, and polls the Solana RPC for the
incoming transfer. Zero wallet connect.

## Flow

1. Merchant supplies recipient address, amount and reference.
2. Server builds a Solana Pay URL using `@solana/pay` (URL only — no signing).
3. URL is encoded as a QR code with `qrcode`.
4. Server polls `getSignaturesForAddress` for the reference until the
   transfer is confirmed, then resolves with the signature.

## Run

```bash
npm i @solana/pay @solana/web3.js qrcode
npx tsx index.ts
```

Open `payment.png` in any image viewer, scan with Phantom / Solflare / any
Solana wallet, approve.

## Why this matters

This is the smallest possible payment surface. No backend database, no API
keys, no SDK. It demonstrates the canonical wallet-less primitive that the
full ZettaPay protocol layers on top of.
