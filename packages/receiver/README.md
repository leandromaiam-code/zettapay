# @zettapay/receiver

> Webhook receiver test tool for the ZettaPay protocol.

Stand up a local HTTP receiver in one command, verify HMAC-SHA256 signatures,
inspect every payload — exactly the checks a production merchant endpoint
must make, made visible during dev and CI.

The same webhook contract is used by the **self-hosted listener** (POSTing
from your droplet) and the **ZettaPay cloud tier** (POSTing across the
internet). A route that passes this tool's checks works for both.

## Install

```bash
npm i -g @zettapay/receiver
```

Or, ephemerally:

```bash
npx @zettapay/receiver listen --secret whsec_xxx
```

## Usage

```bash
zettapay-receiver listen \
  --port 9876 \
  --secret whsec_xxxxxxxxxxxxxxxxxx \
  --pretty
```

Endpoints exposed:

| Method | Path        | Behavior                                              |
| ------ | ----------- | ----------------------------------------------------- |
| `GET`  | `/`         | JSON service status (uptime, request counters).       |
| `POST` | `/webhook`  | Verify signature + replay window, log + respond JSON. |

### Flags

| Flag | Default | Description |
| ---- | ------- | ----------- |
| `--secret <whsec_...>` | (required) | HMAC secret matching the listener config. |
| `--port <n>` | `9876` | Bind port. |
| `--bind <host>` | `127.0.0.1` | Bind host. We default to loopback for safety — pass `0.0.0.0` only on a trusted network. |
| `--max-age <seconds>` | `300` | Replay window. |
| `--pretty` | off | Human-readable box per request. |
| `--log-file <path>` | off | Tee JSON lines to a file. |
| `--exit-on <n>` | off | Exit after N successful webhooks. Useful in CI. |

### Sample session

Terminal 1:

```bash
zettapay-receiver listen --port 9876 --secret $WEBHOOK_SECRET --pretty
```

Terminal 2:

```bash
TS=$(date +%s)
BODY='{"event":"invoice.confirmed","invoice_id":"inv_test","data":{"amount_sats":1000}}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $2}')

curl -X POST http://127.0.0.1:9876/webhook \
  -H "X-ZettaPay-Signature: $SIG" \
  -H "X-ZettaPay-Timestamp: $TS" \
  -d "$BODY"
```

A valid request gets `200 {"ok": true, "received_at": "..."}`. An invalid
signature gets `401 {"ok": false, "error": "invalid_signature"}`. A
timestamp older than 5 minutes gets `401 timestamp_too_old`.

## End-to-end: real listener pointing at the receiver

`@zettapay/listener` (≥ `0.1.2`) accepts `http://localhost` and
`http://127.0.0.1` webhook URLs as a documented dev exception. In any other
case, the listener refuses non-HTTPS targets — TLS is required for real
deployments.

```bash
# .env
MERCHANT_WEBHOOK_URL=http://127.0.0.1:9876/webhook
MERCHANT_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxx
```

When the listener boots with a localhost URL, it logs a single warning:

```
DEV MODE: webhook over plain http allowed for localhost. Use https for production.
```

## Library usage

```ts
import { ReceiverServer } from '@zettapay/receiver';

const server = new ReceiverServer({
  secret: process.env.WEBHOOK_SECRET!,
  port: 0, // OS-assigned
  onWebhook: (outcome) => {
    if (outcome.ok) console.log('ok:', outcome.envelope?.event);
    else console.log('rejected:', outcome.reason);
  },
});

const { port } = await server.listen();
// ... POST to http://127.0.0.1:${port}/webhook ...
await server.close();
```

## Security stance

- Bound to `127.0.0.1` by default; `0.0.0.0` requires an explicit `--bind`.
- HMAC checks use `crypto.timingSafeEqual` over the raw request body.
- Replay window enforced via `X-ZettaPay-Timestamp` header (default 5 min).
- No persistence: every restart starts with zero state.
- No outbound calls: nothing leaves the process.
- No `xpub`/`xprv` handling — receiver only validates signed envelopes.

## License

MIT
