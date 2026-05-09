# @zettapay/api

Express + SQLite REST service that backs **merchant onboarding** for ZettaPay.

## Schema

`merchants`

| column          | type    | constraints                          |
| --------------- | ------- | ------------------------------------ |
| `id`            | INTEGER | PK, autoincrement                    |
| `name`          | TEXT    | NOT NULL                             |
| `wallet_pubkey` | TEXT    | NOT NULL, UNIQUE (Solana base58)     |
| `usdc_ata`      | TEXT    | NOT NULL, UNIQUE (Solana base58 ATA) |
| `created_at`    | INTEGER | NOT NULL, epoch millis               |

## REST endpoints

| method | path             | body / query                                      | response               |
| ------ | ---------------- | ------------------------------------------------- | ---------------------- |
| GET    | `/healthz`       | —                                                 | `{ status, merchants }`|
| GET    | `/merchants`     | `?limit=1..200&offset=0..`                        | `{ items, count }`     |
| POST   | `/merchants`     | `{ name, wallet_pubkey, usdc_ata }`               | `201` merchant         |
| GET    | `/merchants/:id` | —                                                 | merchant or `404`      |
| PATCH  | `/merchants/:id` | partial `{ name?, wallet_pubkey?, usdc_ata? }`    | merchant or `404`/`409`|
| DELETE | `/merchants/:id` | —                                                 | `204` or `404`         |

## Scripts

```bash
npm run dev        # tsx watch
npm run build      # tsc
npm run typecheck  # tsc --noEmit
npm run test       # vitest
npm run start      # node dist/server.js
```

## Env

| var                | default                  | notes                              |
| ------------------ | ------------------------ | ---------------------------------- |
| `PORT`             | `3001`                   | listen port                        |
| `HOST`             | `0.0.0.0`                | listen host                        |
| `ZETTAPAY_DB_PATH` | `./data/zettapay.sqlite` | use `:memory:` for ephemeral state |

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

Outgoing requests carry:

| header                   | purpose                                                         |
| ------------------------ | --------------------------------------------------------------- |
| `X-ZettaPay-Event-Id`    | stable id reused across retries → consumer-side idempotency     |
| `X-ZettaPay-Timestamp`   | unix ms, part of the signed string                              |
| `X-ZettaPay-Signature`   | `sha256=<hex>` HMAC of `${timestamp}.${body}` with shared secret |

Retries fire on transport errors, `5xx`, `408`, `425` and `429`. Other `4xx`
responses are treated as permanent failures (no retry) since the callback URL
won't recover by itself.
