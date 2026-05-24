# @zettapay/listener

Self-hosted, **non-custodial** payment listener for the ZettaPay protocol.

The merchant runs this daemon on their own infrastructure. It watches Bitcoin (and, in upcoming releases, Polygon / Ethereum) addresses derived from the merchant's `xpub`, then dispatches HMAC-signed webhooks to the merchant's own backend when payments confirm.

ZettaPay never sees the merchant's `xprv`. The listener never holds funds. There is no phone-home.

---

## Table of contents

- [Architecture](#architecture)
- [5-minute quickstart](#5-minute-quickstart)
- [Storage adapter — pick one](#storage-adapter--pick-one)
- [Deploy paths](#deploy-paths)
  - [A) Node bare metal](#a-node-bare-metal)
  - [B) systemd](#b-systemd)
  - [C) Docker / docker-compose](#c-docker--docker-compose)
  - [D) Railway one-click](#d-railway-one-click)
- [Configuration reference](#configuration-reference)
- [Webhook signing](#webhook-signing)
- [Troubleshooting](#troubleshooting)
- [Non-custody guarantees](#non-custody-guarantees)
- [Status & release line](#status--release-line)

---

## Architecture

```
   merchant infrastructure (your VPS / k8s / Railway / laptop)
   ┌────────────────────────────────────────────────────────┐
   │                                                        │
   │   @zettapay/listener                                   │
   │   ┌──────────────────────────────────────────────────┐ │
   │   │  BtcListener         WebhookDispatcher           │ │
   │   │  (mempool.space WS)  (HMAC-SHA256, retry curve)  │ │
   │   │           │                  │                   │ │
   │   │           ▼                  ▼                   │ │
   │   │     StorageAdapter (json | sqlite | …)           │ │
   │   │                                                  │ │
   │   │     HealthServer  →  GET /health                 │ │
   │   └──────────────────────────────────────────────────┘ │
   │                  │                    │                │
   └──────────────────┼────────────────────┼────────────────┘
                      │                    │
                      ▼                    ▼
           wss://mempool.space   https://your.shop/zettapay
            (read-only chain)        (your webhook URL)
```

What flows where:

- The listener subscribes over WebSocket to the merchant's BIP-84 receive addresses on `mempool.space` and reconciles via REST on boot.
- Confirmations are tiered by BTC amount (`< $50 → 1 conf`, `< $500 → 3 confs`, `≥ $500 → 6 confs`).
- When an invoice flips to `confirmed`, a webhook event is enqueued in storage.
- The dispatcher polls storage every 2 seconds, signs each event with `MERCHANT_WEBHOOK_SECRET`, and POSTs to `MERCHANT_WEBHOOK_URL`. Failed deliveries follow a Stripe-grade retry curve: `1s, 5s, 30s, 2m, 10m, 30m, 1h, 3h, 12h, 24h` — 10 attempts, then dead-lettered.
- Liveness / readiness is exposed at `GET /health` (port `8787` by default).

---

## 5-minute quickstart

```bash
# 1. Install the daemon
npm install -g @zettapay/listener

# 2. Bootstrap your data dir with a merchant record (one-time)
mkdir -p ~/.zettapay/data
cat > ~/.zettapay/data/merchant.json <<'EOF'
{
  "id": "m_local_dev",
  "shop_name": "Your Shop",
  "email": "you@your.shop",
  "xpub": "zpub6r…",
  "webhook_url": "https://your.shop/zettapay",
  "webhook_secret_hash": "sha256:…",
  "next_child_index": 0,
  "created_at": "2026-01-01T00:00:00.000Z"
}
EOF

# 3. Export the two required env vars + the merchant id
export MERCHANT_ID=m_local_dev
export MERCHANT_WEBHOOK_URL=https://your.shop/zettapay
export MERCHANT_WEBHOOK_SECRET=whsec_replace_me

# 4. Start the listener
zettapay-listener start
```

Verify it's alive:

```bash
curl http://127.0.0.1:8787/health
# {"ok":true,"ws_connected":true,"subscribed_count":0,"last_event_at":null,"last_block_height":850123,"uptime_s":7}
```

> **Note on `init`.** A guided `zettapay-listener init / migrate / healthcheck` CLI lands in the next release. For now you bootstrap the merchant row by writing `merchant.json` directly (the file shape is documented in [`docs/architecture/self-hosted-listener-design.md`](../../docs/architecture/self-hosted-listener-design.md#2-json-storage-layout)) or by calling `JsonFileStorage.createMerchant()` from a small script. SQLite users can run the same `createMerchant()` call against a `SqliteStorage` instance — the columns mirror the JSON layout 1-for-1.

---

## Storage adapter — pick one

`@zettapay/listener` ships a swappable `StorageAdapter`. Pick the one that matches your volume — the schemas are identical, so you can migrate later without losing data.

```
                    pick an adapter
                          │
        ┌─────────────────┼──────────────────────────┐
        │                 │                          │
   < 1k inv/mo       1k–100k inv/mo            > 100k inv/mo
   single host        single host         OR multi-host fleet
        │                 │                          │
        ▼                 ▼                          ▼
      json             sqlite                  supabase / postgres
   (default,        (peer dep:               (peer dep:
   zero deps)       better-sqlite3)          @supabase/supabase-js or pg)
```

| adapter           | status                | tier   | best for                                | install                              |
|-------------------|-----------------------|--------|-----------------------------------------|--------------------------------------|
| `json` (default)  | available (Z56)       | tier-1 | < 1k invoices/month, single host        | zero extra deps                      |
| `sqlite`          | available (Z59)       | tier-2 | 1k–100k invoices/month, single host     | `npm install better-sqlite3`         |
| `supabase`        | in flight (Z57)       | tier-3 | unlimited, hosted Postgres + auth       | `npm install @supabase/supabase-js`  |
| `postgres`        | in flight (Z62)       | tier-3 | unlimited, self-hosted Postgres         | `npm install pg`                     |

Switching adapters is `STORAGE=json | sqlite | supabase | postgres`. The peer dependency is loaded lazily — listeners on the default (`json`) boot without any of the others installed (`HR-OPTIONAL-DEPS`).

---

## Deploy paths

All four paths run the **same** `zettapay-listener` binary against the **same** storage layout. Pick the one that matches your operations style.

### A) Node bare metal

Useful for: a quick VPS, your laptop, a Raspberry Pi.

```bash
# Prereqs: Node ≥ 18.18, a merchant xpub, an HTTPS webhook URL.
npm install -g @zettapay/listener

# Bootstrap data dir (one-time)
mkdir -p ~/.zettapay/data
$EDITOR ~/.zettapay/data/merchant.json   # see quickstart for the schema

# Export config
export MERCHANT_ID=m_<your-id>
export MERCHANT_WEBHOOK_URL=https://your.shop/zettapay
export MERCHANT_WEBHOOK_SECRET=whsec_<your-secret>
export STORAGE=json                       # or sqlite — see "Storage adapter"
export ZETTAPAY_DATA_DIR=$HOME/.zettapay/data

# Run in foreground (Ctrl-C to stop)
zettapay-listener start

# Or under nohup / tmux / screen for a quick background run
nohup zettapay-listener start > zettapay.log 2>&1 &
```

For anything beyond "I'm kicking the tires", graduate to systemd (B) or Docker (C).

### B) systemd

Useful for: a long-running Linux server you own. Survives reboots, logs to `journalctl`, hardened sandbox.

```bash
# Install the binary system-wide
sudo npm install -g @zettapay/listener

# Create the service user + data dir
sudo useradd --system --home /var/lib/zettapay --shell /usr/sbin/nologin zettapay
sudo mkdir -p /var/lib/zettapay/data /etc/zettapay
sudo chown -R zettapay:zettapay /var/lib/zettapay

# Drop in the env file (mode 0640 — secret is in here)
sudo install -m 0640 -o root -g zettapay \
  deploy/systemd/zettapay-listener.env /etc/zettapay/listener.env
sudoedit /etc/zettapay/listener.env       # fill MERCHANT_WEBHOOK_URL + SECRET + ID

# Drop in the unit file
sudo install -m 0644 \
  deploy/systemd/zettapay-listener.service /etc/systemd/system/

# Bootstrap the merchant row (one-time)
sudo -u zettapay $EDITOR /var/lib/zettapay/data/merchant.json

# Enable + start
sudo systemctl daemon-reload
sudo systemctl enable --now zettapay-listener.service

# Verify
systemctl status zettapay-listener
journalctl -u zettapay-listener -f
curl http://127.0.0.1:8787/health
```

The unit ships with `ExecStartPost` health probe (waits up to 30s for `/health` to bind), `Restart=always`, a dedicated `User=zettapay`, and a stack of hardening directives (`NoNewPrivileges`, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/zettapay`, …). See [`deploy/systemd/zettapay-listener.service`](deploy/systemd/zettapay-listener.service) and the matching env template [`deploy/systemd/zettapay-listener.env`](deploy/systemd/zettapay-listener.env).

### C) Docker / docker-compose

Useful for: any container-based stack — fly.io, Kubernetes, Nomad, plain `docker run`, ECS, etc.

#### Plain `docker run`

```bash
docker build -t zettapay-listener packages/listener

docker run -d --name zettapay-listener \
  -p 8787:8787 \
  -v $PWD/data:/data \
  --env-file ./zettapay-listener.env \
  zettapay-listener
```

A minimal `zettapay-listener.env`:

```dotenv
MERCHANT_ID=m_prod
MERCHANT_WEBHOOK_URL=https://your.shop/zettapay
MERCHANT_WEBHOOK_SECRET=whsec_replace_me
STORAGE=json
ZETTAPAY_DATA_DIR=/data
HEALTH_PORT=8787
```

#### `docker-compose`

```bash
cd packages/listener/deploy/docker
# Edit zettapay-listener.env in this directory
docker compose up -d
docker compose logs -f listener
```

The shipped [`docker-compose.yml`](deploy/docker/docker-compose.yml) wires:

- the listener service with a restart policy,
- a named volume mounted at `/data` (for `STORAGE=json` or `STORAGE=sqlite`),
- a `healthcheck` against `/health`,
- env loading from `zettapay-listener.env`.

### D) Railway one-click

Useful for: zero-ops hosting. Free tier handles thousands of invoices/month.

1. Open [the template](https://railway.app/new/template?template=https://github.com/leandromaiam-code/zettapay/tree/main/packages/listener/deploy/railway) (replace with your fork if you've vendored the package).
2. Set the four env vars in the Railway UI: `MERCHANT_ID`, `MERCHANT_WEBHOOK_URL`, `MERCHANT_WEBHOOK_SECRET`, optionally `STORAGE`.
3. Hit **Deploy**.

The [`railway.json`](deploy/railway/railway.json) descriptor pins:

- `nixpacks` builder (Node 22),
- `startCommand: zettapay-listener start`,
- `healthcheckPath: /health` on port `8787`,
- `restartPolicyType: ON_FAILURE` (max 10 retries),
- a Railway-managed volume mounted at `/data` so `STORAGE=json` survives redeploys.

For volumes > 1 GB of invoice JSON, switch `STORAGE` to `sqlite` (single-file ACID) or `supabase` (off-host Postgres).

---

## Configuration reference

| env var                    | required | default                          | notes                                                                    |
|----------------------------|----------|----------------------------------|--------------------------------------------------------------------------|
| `MERCHANT_WEBHOOK_URL`     | yes      | —                                | HTTPS only — `http://` is rejected at boot.                              |
| `MERCHANT_WEBHOOK_SECRET`  | yes      | —                                | HMAC-SHA256 key. Keep secret; rotate via storage update.                 |
| `MERCHANT_ID`              | no\*     | `default`                        | Falls back to the merchant with `id="default"` if unset.                 |
| `STORAGE`                  | no       | `json`                           | One of `json`, `sqlite`, `supabase`, `postgres`.                         |
| `ZETTAPAY_DATA_DIR`        | no       | `~/.zettapay/data`               | JSON adapter on-disk root. Also the default parent for the SQLite file.  |
| `ZETTAPAY_SQLITE_FILE`     | no       | `<dataDir>/zettapay.db`          | SQLite adapter only — explicit single-file path override.                |
| `HEALTH_PORT`              | no       | `8787`                           | `GET /health` listens here.                                              |
| `MEMPOOL_WS_URL`           | no       | `wss://mempool.space/api/v1/ws`  | Override for self-hosted mempool.space instance.                         |
| `MEMPOOL_REST_URL`         | no       | `https://mempool.space/api`      | REST backfill base.                                                      |

\* `MERCHANT_ID` is optional only if there is exactly one merchant in storage with `id="default"`. With multiple merchants, set it explicitly.

---

## Webhook signing

Every POST to `MERCHANT_WEBHOOK_URL` carries:

| header                   | value                                              |
|--------------------------|----------------------------------------------------|
| `X-ZettaPay-Signature`   | `hex(hmac_sha256(MERCHANT_WEBHOOK_SECRET, body))`  |
| `X-ZettaPay-Timestamp`   | unix-ms at attempt time                            |
| `X-ZettaPay-Event-Id`    | stable event id (idempotency key)                  |
| `X-ZettaPay-Attempt`     | 1-indexed attempt number                           |

Reference verification (Node):

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(body: string, sig: string, secret: string): boolean {
  const expected = createHmac('sha256', secret).update(body).digest();
  const given = Buffer.from(sig, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given);
}
```

Treat `X-ZettaPay-Event-Id` as your idempotency key — the dispatcher reuses the same id across all retries.

---

## Troubleshooting

### `/health` reports `ws_connected: false`

The mempool.space WebSocket is down or your network blocks `wss://`. The listener will keep retrying with `1s, 5s, 30s, 5m` backoff.

- Confirm outbound TLS is open: `curl -I https://mempool.space/api/blocks/tip/height`
- Check the unit / container logs for `btc_listener.ws_error` lines.
- Behind a corporate egress proxy? Set `MEMPOOL_WS_URL` to a self-hosted mempool.space mirror.

### Webhooks never arrive at my backend

- `curl -X POST $MERCHANT_WEBHOOK_URL -d '{}'` from the listener host — make sure your endpoint is publicly reachable over HTTPS.
- The dispatcher refuses `http://` URLs at boot. Symptom: the daemon exits with `MERCHANT_WEBHOOK_URL must use https://`.
- Grep logs for `webhook_dispatcher.failed` — the `status` and `error` fields show what your endpoint returned. Non-2xx triggers the retry curve.
- The default request timeout is 10s. A slow webhook handler will be retried 10 times across ~36 hours before the event dead-letters.

### Invoice never flips to `confirmed`

- Confirmations are tiered by BTC amount: `< $50 → 1`, `< $500 → 3`, `≥ $500 → 6`. Until that threshold is met the status stays `pending`.
- Check the `subscribed_count` field on `/health` — if it's `0`, the listener has no pending invoices to watch (have you created one against `MERCHANT_ID`?).
- Reconciliation runs every 30s; a missed WS event will be backfilled on the next tick.
- `child_index = null` means the invoice is on a legacy non-derived address. The watcher handles both, but legacy invoices are not derived from your xpub.

### Reading logs

The listener emits **structured JSON to stdout** (`level: info | warn | error`) — pipe it through `jq` for filtering:

```bash
# bare metal / docker
zettapay-listener start | jq 'select(.level=="warn" or .level=="error")'

# systemd
journalctl -u zettapay-listener -f -o cat | jq

# docker compose
docker compose logs -f --no-color listener | jq
```

Useful event keys:

- `zettapay_listener.started` — process boot, prints `merchant_id` + `storage` kind.
- `btc_listener.ws_connected` / `btc_listener.ws_error` / `btc_listener.ws_reconnect`.
- `btc_listener.invoice_confirmed` — invoice flipped to `confirmed`.
- `webhook_dispatcher.delivered` — 2xx from your endpoint.
- `webhook_dispatcher.failed` — non-2xx or transport error; carries `attempt` + `status`.
- `webhook_dispatcher.dead` — event hit attempt 10 and is parked.

---

## Non-custody guarantees

These rules are enforced by the `HR-*` hard rules in [`fabric/seed/zettapay_hrs.json`](../../fabric/seed/zettapay_hrs.json) and pre-merge HR scans block any code that violates them.

- **`HR-CUSTODY`.** The listener never holds, derives, or signs with a private key. It watches addresses derived from the merchant's **public** `xpub`. ZettaPay's services never see your `xprv`.
- **`HR-PHONE-HOME`.** The listener MUST NOT contact `zettapay.vercel.app`, `zettapay.dev`, `zettapay.com`, or `api.zettapay.*`. Outbound traffic is limited to `mempool.space` (or your configured indexer), your `MERCHANT_WEBHOOK_URL`, and (when configured) your `STORAGE` adapter URL. Block the ZettaPay-controlled hosts at your firewall — the listener will keep working.
- **`HR-WALLET-LESS`.** No `wallet.connect`, no Phantom / MetaMask UI, no browser-side signing. The listener is a daemon, not a frontend.
- **`HR-OPTIONAL-DEPS`.** `better-sqlite3`, `@supabase/supabase-js`, and `pg` are `peerDependenciesMeta: optional` — only the storage adapter you actually pick is loaded.
- **`HR-STORAGE-ADAPTER`.** Listener business logic depends only on the `StorageAdapter` interface. Concrete adapters live under `src/storage/` and are loaded lazily by the factory.

---

## Status & release line

This release wraps the Z55–Z59 line, plus deploy artifacts:

- Z55 — `StorageAdapter` interface + contract test suite + design doc.
- Z56 — `JsonFileStorage` (default, zero deps, atomic-rename writes + `proper-lockfile`).
- Z57 — `SupabaseStorage` adapter (in flight).
- Z58 — `BtcListener` + `WebhookDispatcher` + `HealthServer` + `zettapay-listener start` bin + Dockerfile.
- Z59 — `SqliteStorage` (ACID single-file via `better-sqlite3`, lazy peer).
- Z60 — `zettapay-listener` CLI: `init` / `start` / `migrate` / `healthcheck` / `verify-config` (in flight).
- Z61 — this release: deploy artifacts (systemd / docker / Railway) + docs + `0.2.0` version cut.
- Z62 — `PostgresStorage` adapter (planned).

Once Z60 merges the README quickstart drops the hand-edited `merchant.json`
step in favour of `zettapay-listener init --xpub ...`.

## License

MIT.
