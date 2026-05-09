# @zettapay/api

HTTP API for ZettaPay — merchant onboarding + USDC P2P payments on Solana.

## Endpoints

| Method | Path                   | Purpose                                    |
| ------ | ---------------------- | ------------------------------------------ |
| GET    | `/health`              | Liveness probe                             |
| POST   | `/merchants/register`  | Create a merchant account + issue API key  |
| POST   | `/pay`                 | Transfer USDC payer ATA → merchant ATA     |

## POST /pay

Request body:

```json
{
  "merchantId": "merch_...",
  "amountUsdc": 12.5,
  "payerWallet": "<optional base58 — defaults to PAYER_SECRET_KEY pubkey>",
  "metadata": { "invoice": "INV-1" }
}
```

Response (201):

```json
{
  "payment": {
    "id": "pay_...",
    "merchantId": "merch_...",
    "amountUsdc": 12.5,
    "payerWallet": "<base58>",
    "status": "completed",
    "txSignature": "<base58 sig>",
    "metadata": { "invoice": "INV-1" },
    "createdAt": "2026-05-09T12:00:00.000Z",
    "completedAt": "2026-05-09T12:00:01.234Z"
  },
  "txSignature": "<base58 sig>"
}
```

The transfer uses `transferChecked` against the configured USDC SPL mint. The
facilitator keypair (`PAYER_SECRET_KEY`, base58 or JSON array) signs both the
payer ATA debit and the create-if-missing instruction for the recipient ATA.
On failure the payment row is left with `status = 'failed'` and the underlying
error is captured in `error_message`.

## Local dev

```bash
cp .env.example .env
# fill PAYER_SECRET_KEY with a devnet keypair holding test-USDC
npm install
npm run dev --workspace @zettapay/api
```

## Tests

```bash
npm run test --workspace @zettapay/api
```
