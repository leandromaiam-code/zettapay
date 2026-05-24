# @zettapay/listener

Self-hosted, **non-custodial** payment listener for the ZettaPay protocol.

## What it is

A small daemon a merchant runs on their own infrastructure to:

- watch on-chain activity for invoices generated from their `xpub` (BIP-84 BTC, BIP-44 EVM),
- dispatch HMAC-signed webhooks to the merchant's own backend when payments confirm,
- persist invoice and webhook state locally through a swappable `StorageAdapter` (JSON / SQLite / Supabase / Postgres).

## What it is not

- **Not custodial.** The listener never holds, derives, or signs with a private key. It only watches addresses derived from the merchant's `xpub`. See `HR-CUSTODY`.
- **Not wallet-coupled.** No `wallet.connect`, no Phantom/MetaMask UI, no browser-side signing. See `HR-WALLET-LESS`.
- **No phone-home.** The listener MUST NOT contact `zettapay.vercel.app`, `zettapay.dev`, `zettapay.com`, or `api.zettapay.*`. Outbound traffic is limited to `mempool.space` (and any merchant-configured chain RPC), the merchant's configured `MERCHANT_WEBHOOK_URL`, and the `STORAGE` adapter URL when the merchant chooses Supabase or Postgres. See `HR-PHONE-HOME`.

## Status — Z59

- `StorageAdapter` interface + type definitions (Z55).
- Contract test suite at `test/storage-contract.ts` (Z55).
- **`JsonFileStorage`** — Z56, the zero-deps default (tier-1).
- **`SqliteStorage`** — Z59, ACID single-file via `better-sqlite3` (tier-2).
- Cloud adapters (Supabase / Postgres) — Z58 / Z60 (in progress).
- **`BtcListener` + `WebhookDispatcher` + `HealthServer` + `zettapay-listener` bin + Dockerfile** — Z58.
- Full `zettapay-listener init / migrate / healthcheck` CLI — Z60.

## Running it

The package ships a `zettapay-listener` binary. Minimum env to boot:

```bash
export STORAGE=json                                      # default — zero extra deps
export ZETTAPAY_DATA_DIR=/var/lib/zettapay/data          # JSON adapter on-disk root
export MERCHANT_WEBHOOK_URL=https://your.shop/zettapay   # https only
export MERCHANT_WEBHOOK_SECRET=whsec_...                 # HMAC-SHA256 key
export HEALTH_PORT=8787                                  # /health probe port

zettapay-listener start
```

The merchant row must exist in storage first (Z60 will ship the `init`
subcommand; meanwhile use the `JsonFileStorage` API programmatically).

### `GET /health`

```json
{
  "ok": true,
  "ws_connected": true,
  "subscribed_count": 12,
  "last_event_at": 1716480000000,
  "last_block_height": 850123,
  "uptime_s": 3600
}
```

### Webhook signing

Every POST to `MERCHANT_WEBHOOK_URL` carries:

| header                   | value                                              |
|--------------------------|----------------------------------------------------|
| `X-ZettaPay-Signature`   | `hex(hmac_sha256(MERCHANT_WEBHOOK_SECRET, body))`  |
| `X-ZettaPay-Timestamp`   | unix-ms at attempt time                            |
| `X-ZettaPay-Event-Id`    | stable event id (idempotency key)                  |
| `X-ZettaPay-Attempt`     | 1-indexed attempt number                           |

Retry curve: `1s, 5s, 30s, 2m, 10m, 30m, 1h, 3h, 12h, 24h` — 10 attempts
before the event parks in a dead-letter state.

### Docker

```bash
docker build -t zettapay-listener packages/listener
docker run --rm -p 8787:8787 \
  -v $PWD/data:/data \
  -e MERCHANT_WEBHOOK_URL=https://your.shop/zettapay \
  -e MERCHANT_WEBHOOK_SECRET=whsec_... \
  zettapay-listener
```

## Storage adapters

| adapter           | status                  | tier      | best for                                  | install                                  |
|-------------------|-------------------------|-----------|-------------------------------------------|------------------------------------------|
| `json` (default)  | available (Z56)         | tier-1    | up to ~1k invoices/month, single host     | zero extra deps                          |
| `sqlite`          | available (Z59)         | tier-2    | up to ~100k invoices/month, single host   | `npm install better-sqlite3`             |
| `supabase`        | coming soon (Z58)       | tier-3    | unlimited, hosted Postgres + auth         | `npm install @supabase/supabase-js`      |
| `postgres`        | coming soon (Z60)       | tier-3    | unlimited, self-hosted Postgres           | `npm install pg`                         |

### Choosing an adapter

```
< 1k invoices / month          → json     (default; no install)
1k–100k invoices / month       → sqlite   (single file; ACID; ~100x faster than json on hot paths)
> 100k invoices / month        → supabase / postgres
multi-host listener fleet      → supabase / postgres (shared DB)
```

JSON, SQLite, Supabase and Postgres all share the **same column names and
types** — `zettapay-listener migrate --from <a> --to <b>` is a pure
round-trip (see design doc §6).

### `JsonFileStorage` (default)

Persists all merchant + invoice + webhook state under
`~/.zettapay/data/` (override via `--data-dir` / `ZETTAPAY_DATA_DIR`):

```
~/.zettapay/data/
├── merchant.json
├── invoices/inv_<id>.json
├── webhook_events/evt_<id>.json
└── .lock                       # proper-lockfile sentinel
```

Atomic-write guarantees:

- every write goes through `<file>.tmp.<pid>.<rand>` → `rename(2)` — atomic on POSIX.
- `nextChildIndex` is serialized in-process (promise queue) **and** across processes (`proper-lockfile` on `merchant.json`). 100 parallel callers receive `{0..99}` distinct indexes, no duplicates.

Programmatic construction:

```ts
import { JsonFileStorage, createStorage } from '@zettapay/listener';

const storage = new JsonFileStorage({ dataDir: process.env.ZETTAPAY_DATA_DIR });
// or, env-driven:
const fromEnv = createStorage(process.env); // STORAGE defaults to 'json'
```

### `SqliteStorage` (tier-2, ACID, single-file)

Persists everything in a single `<dataDir>/zettapay.db` SQLite file
(override via `filename` or the `ZETTAPAY_SQLITE_FILE` env var). Schema is
identical to the JSON adapter's logical layout — `migrate --from json --to
sqlite` is byte-equivalent round-trip-safe.

```ts
import { SqliteStorage, createStorage } from '@zettapay/listener';

const storage = new SqliteStorage({ filename: '/var/lib/zettapay.db' });
// or, env-driven:
process.env.STORAGE = 'sqlite';
const fromEnv = createStorage(process.env);
```

Atomicity:

- `journal_mode = WAL` for crash safety on POSIX (silently ignored for `:memory:`).
- `nextChildIndex` uses `BEGIN IMMEDIATE` so 100 in-process concurrent callers
  receive `{0..99}` distinct indexes, no duplicates (same conformance bar as JSON).
- `better-sqlite3` is loaded lazily via `createRequire` — listeners running
  with `STORAGE=json` (the default) boot without it installed (HR-OPTIONAL-DEPS).
  A missing peer surfaces as `MissingStorageDependencyError` with the install hint.

## Design doc

See [`docs/architecture/self-hosted-listener-design.md`](../../docs/architecture/self-hosted-listener-design.md) for the canonical interface, JSON storage layout, dependency graph, CLI surface, phone-home prohibition, migration story, and conformance map.

## Optional peer dependencies

| `STORAGE=` | required peer dep             | install command                        |
|------------|-------------------------------|----------------------------------------|
| `json`     | (none — default)              | —                                      |
| `sqlite`   | `better-sqlite3`              | `npm install better-sqlite3`           |
| `supabase` | `@supabase/supabase-js`       | `npm install @supabase/supabase-js`    |
| `postgres` | `pg`                          | `npm install pg`                       |

`proper-lockfile` is a hard dependency — it is what makes the default JSON
adapter race-safe. A missing optional peer (for the non-default adapters)
throws `MissingStorageDependencyError` with the exact install hint.

## License

MIT.
