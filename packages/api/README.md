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
