# 08 · Webhook receiver

Production-quality webhook receiver pattern:

- HMAC-SHA256 signature verification with constant-time compare.
- Replay protection via `zettapay-timestamp` header + 5-minute window.
- Idempotency via the event `id`.
- Returns 2xx fast; defers business logic to a queue (here just an in-process array, swap for SQS/PG-NOTIFY/Inngest in prod).

## Run

```bash
cp .env.example .env
npm install
npm start
```

Then in your dashboard point a webhook at `https://<your-ngrok>.ngrok.io/zettapay/webhook`.

## Files

- `server.mjs` — Express server with the verify/replay/idempotency middleware.
