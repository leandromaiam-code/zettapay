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

| method | path             | body / query                                      | response                |
| ------ | ---------------- | ------------------------------------------------- | ----------------------- |
| GET    | `/healthz`       | —                                                 | `{ status, merchants }` |
| GET    | `/merchants`     | `?limit=1..200&offset=0..`                        | `{ items, count }`      |
| POST   | `/merchants`     | `{ name, wallet_pubkey, usdc_ata }`               | `201` merchant          |
| GET    | `/merchants/:id` | —                                                 | merchant or `404`       |
| PATCH  | `/merchants/:id` | partial `{ name?, wallet_pubkey?, usdc_ata? }`    | merchant or `404`/`409` |
| DELETE | `/merchants/:id` | —                                                 | `204` or `404`          |
| POST   | `/onramp`        | `{ merchant_id, base_currency_amount?, ... }`     | MoonPay URL or `503`    |

### `POST /onramp`

Builds a MoonPay onramp URL whose `walletAddress` is the merchant's USDC ATA.
The host (`buy-sandbox.moonpay.com` vs `buy.moonpay.com`) and `apiKey` are
selected from `MOONPAY_ENV` and `MOONPAY_API_KEY` at boot. When
`MOONPAY_API_KEY` is unset the route returns `503 onramp_disabled`.

Request body (all fields except `merchant_id` are optional):

| field                     | type    | notes                                              |
| ------------------------- | ------- | -------------------------------------------------- |
| `merchant_id`             | integer | merchant primary key                               |
| `currency_code`           | string  | crypto currency code; defaults to `usdc_sol`       |
| `base_currency_amount`    | number  | fiat amount to prefill                             |
| `base_currency_code`      | string  | fiat currency code (e.g. `usd`, `brl`)             |
| `redirect_url`            | string  | absolute URL the user returns to after purchase    |
| `external_customer_id`    | string  | merchant-side buyer id                             |
| `external_transaction_id` | string  | merchant-side transaction id                       |

The same builder is exposed as the MCP `create_onramp_url` tool.

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

| var                        | default                  | notes                                                       |
| -------------------------- | ------------------------ | ----------------------------------------------------------- |
| `PORT`                     | `3001`                   | listen port                                                 |
| `HOST`                     | `0.0.0.0`                | listen host                                                 |
| `ZETTAPAY_DB_PATH`         | `./data/zettapay.sqlite` | use `:memory:` for ephemeral state                          |
| `MOONPAY_API_KEY`          | —                        | publishable key (`pk_test_*` or `pk_live_*`); enables `/onramp` |
| `MOONPAY_ENV`              | `sandbox`                | `sandbox` or `production` — picks `buy-sandbox.` vs `buy.` host |
| `MOONPAY_DEFAULT_CURRENCY` | `usdc_sol`               | currencyCode used when caller doesn't override              |

## Webhook dispatcher

`dispatchWebhook()` POSTs a JSON payload to a merchant callback URL with retry
**3x exponential backoff** at the canonical schedule **1s · 5s · 15s** (initial
attempt + up to three retries, four total tries).

```ts
import { dispatchWebhook } from '@zettapay/api';

const result = await dispatchWebhook({
  url: merchant.callbackUrl,
  payload: { event: 'payment.confirmed', amount: '10.00', txSig },
  secret: process.env.WEBHOOK_SIGNING_SECRET,
  eventId: paymentId,
});
```
