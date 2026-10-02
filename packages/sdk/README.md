# @zettapay/sdk

TypeScript SDK for ZettaPay — non-custodial payments in **Bitcoin** and
**USDC / USDT on Base**. It talks to the two servers that make up the product:

- the self-hosted [`@zettapay/listener`](../listener) (`POST /invoice`,
  `GET /invoice/:id`, `GET /health`), and
- **ZettaPay Cloud**, the same API run as a managed service under `/api/v1`.

The SDK does two things: create and read invoices, and verify the
HMAC-signed webhook that fires when an invoice is paid. Funds always settle
on-chain directly to the merchant's wallet; the SDK never sees a signing key.

## Install

```bash
npm install @zettapay/sdk
```

Node 18.18 or newer. The two entry points below have no runtime dependencies
beyond the platform (`fetch`, and `node:crypto` for webhooks).

| Import | Contains | Runs in |
| --- | --- | --- |
| `@zettapay/sdk/api` | `ZettaPayApi` client, typed errors, response types | Node, edge runtimes, browsers |
| `@zettapay/sdk/webhooks` | `verifyWebhook`, event types | Node |

Both are also re-exported from the package root, but the root additionally
loads the legacy Solana-era modules — prefer the subpaths.

## Create an invoice

```ts
import { ZettaPayApi } from '@zettapay/sdk/api';

// Self-hosted listener
const zp = new ZettaPayApi({
  baseUrl: 'http://localhost:8787',
  target: 'listener',
  apiKey: process.env.ZETTAPAY_API_KEY,
});

// ZettaPay Cloud — same client, different target
const cloud = new ZettaPayApi({
  baseUrl: process.env.ZETTAPAY_CLOUD_URL!, // origin of the Cloud deployment
  target: 'cloud',
  apiKey: process.env.ZETTAPAY_API_KEY,
});
```

`target` is required and selects the route prefix (`''` for the listener,
`/api/v1` for Cloud). It is never guessed from the URL. If the server sits
behind a path of your own, pass `pathPrefix` to override it. There is no
default `baseUrl`.

```ts
// Bitcoin — amount in satoshis
const btc = await zp.createBtcInvoice({ amountSats: 2000, memo: 'Order 123' });
btc.receive_address; // bc1q…
btc.qr_uri;          // BIP-21 URI — render as a QR code

// USDC on Base — amount in USD (asset defaults to 'usdc')
const usdc = await zp.createBaseInvoice({ amountUsd: 29 });
usdc.amount_usdc;    // "29.000042" — the exact amount the payer must send
usdc.qr_uri;         // EIP-681 URI — render as a QR code

// USDT on Base
const usdt = await zp.createBaseInvoice({ amountUsd: 29, asset: 'usdt' });

// Follow the status
const invoice = await zp.getInvoice(usdc.invoice_id);
invoice.status;      // 'pending' | 'partial' | 'confirmed' | 'expired' | 'failed'

// Liveness
const health = await zp.health();
```

### Showing the invoice to the payer

- **Cloud:** when the service has a checkout origin configured, the create
  response carries `checkout_url` — redirect the payer there.
- **Anywhere:** render `qr_uri` as a QR code and show `receive_address` plus the
  amount (`amount_sats` / `amount_btc` for Bitcoin, `amount_usdc` for Base).

In fixed-address mode (`mode: 'fixed-address'`) every invoice shares one
receive address and is identified by the low decimals of the amount, so the
payer must send **exactly** `amount_usdc`.

### Methods

| Method | Request | Returns |
| --- | --- | --- |
| `createBtcInvoice({ amountSats, memo?, expiresInSeconds? })` | `POST {prefix}/invoice` `{ chain: 'btc', amount_sats, memo?, expires_in? }` | `BtcInvoiceCreated` |
| `createBaseInvoice({ amountUsd, asset?, expiresInSeconds? })` | `POST {prefix}/invoice` `{ chain: 'base', amount_usd, asset, expires_in? }` | `BaseInvoiceCreated` |
| `getInvoice(invoiceId)` | `GET {prefix}/invoice/:id` | `ZettaPayInvoice` |
| `health()` | `GET {prefix}/health` | `ListenerHealth \| CloudHealth` |

The API key is sent as `X-ZettaPay-Api-Key` on every call when set. Cloud
requires it for invoice calls; the listener requires it for `POST /invoice`
when `ZETTAPAY_API_KEY` is configured. Keep it on your server.

Things the servers do that are worth knowing:

- `expiresInSeconds` is honoured by the listener for Bitcoin and for Base in
  xpub mode. Cloud and fixed-address invoices use the server's own TTL.
- A deployment in **xpub mode** issues USDC whatever `asset` says. The client
  does not return such an invoice when you asked for `usdt`: it throws
  `ZettaPayApiError` with `code: 'asset_mismatch'` (the invoice the server
  created is in `error.details`).
- On stablecoin invoices the `amount_btc` field holds the integer token base
  units. Read `amount_usdc` / `amount_usdc_units` instead.

### Errors

Every failure is a `ZettaPayApiError` with `code`, `status` and `details`.
`code` is the server's `error.code` (`unauthorized`, `invalid_amount`,
`chain_disabled`, `asset_disabled`, `base_disabled`, `not_found`, `capacity`,
`create_failed`, …) or a client-side one (`invalid_request`, `asset_mismatch`,
`http_error`, `invalid_response`, `network_error`, `timeout`).

Two cases have their own class:

```ts
import { PlanLimitReachedError, RateLimitedError, ZettaPayApiError } from '@zettapay/sdk/api';

try {
  await cloud.createBtcInvoice({ amountSats: 2000 });
} catch (err) {
  if (err instanceof PlanLimitReachedError) {
    // HTTP 402 plan_limit_reached (Cloud): monthly invoice cap of the plan
    console.log(err.plan, err.limit, err.used);
  } else if (err instanceof RateLimitedError) {
    // HTTP 429
    console.log('retry in', err.retryAfterSeconds, 's');
  } else if (err instanceof ZettaPayApiError) {
    console.log(err.status, err.code, err.message);
  }
}
```

## Verify a webhook

When a payment confirms, the listener / Cloud POSTs a JSON event to your
webhook URL with these headers:

| Header | Value |
| --- | --- |
| `X-ZettaPay-Signature` | hex HMAC-SHA256 of the **raw body**, keyed by your webhook secret |
| `X-ZettaPay-Timestamp` | delivery time, epoch **milliseconds** |
| `X-ZettaPay-Event-Id` | event id, reused across retries of the same event |
| `X-ZettaPay-Attempt` | 1-indexed attempt number |

```ts
import express from 'express';
import { verifyWebhook, WebhookVerificationError } from '@zettapay/sdk/webhooks';

const app = express();

// The raw body is required — do not let a JSON parser touch it first.
app.post('/webhooks/zettapay', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const { event, eventId } = verifyWebhook({
      rawBody: req.body,
      headers: req.headers,
      secret: process.env.MERCHANT_WEBHOOK_SECRET!, // e.g. whsec_xxxxxxxxxxxxxxxxxxxxxxxx
    });

    if (eventId && (await alreadyProcessed(eventId))) return res.sendStatus(200);

    if (event.event === 'invoice.confirmed') {
      await markOrderPaid(event.invoice_id, event.tx_hash);
    }
    res.sendStatus(200);
  } catch (err) {
    if (err instanceof WebhookVerificationError) return res.status(401).send(err.code);
    throw err;
  }
});
```

With the Fetch API (Next.js route handlers, Hono, …):

```ts
export async function POST(req: Request) {
  const { event } = verifyWebhook({
    rawBody: await req.text(),
    headers: req.headers,
    secret: process.env.MERCHANT_WEBHOOK_SECRET!,
  });
  // …
  return new Response(null, { status: 200 });
}
```

`verifyWebhook` throws `WebhookVerificationError` with a `code`:
`missing_signature`, `malformed_signature`, `signature_mismatch`,
`missing_timestamp`, `invalid_timestamp`, `timestamp_out_of_tolerance`,
`invalid_payload`. Any non-2xx reply makes the dispatcher retry (up to 10
attempts with growing delays).

The signature covers the body only — the timestamp header is not signed. The
default 5-minute tolerance (`toleranceMs`, `null` to disable) drops stale
deliveries, but **idempotency must come from `eventId`**: store it and skip
events you have already handled.

### Events

Payloads are flat objects discriminated by `event`.

`invoice.confirmed`

| Field | Notes |
| --- | --- |
| `invoice_id`, `merchant_id` | |
| `chain` | `btc` or `base` |
| `asset` | `BTC`, `USDC` or `USDT` |
| `amount` | invoice amount — decimal BTC, or integer token base units (6 decimals) |
| `address` | address that was paid |
| `tx_hash` | |
| `confirmed_at` | ISO-8601 |
| `confirmations` | Bitcoin only |
| `balance` | Base, xpub mode — token balance of the invoice address |
| `value`, `token_address`, `metadata` | Base, fixed-address mode — `metadata` is `{ mode, ref, nonce, asset }` |

`payment.orphan` (fixed-address mode only) — a transfer reached the shared
address but matched no active invoice (wrong amount, or the invoice expired).
Fields: `merchant_id`, `chain`, `asset`, `token_address`, `address`, `tx_hash`,
`value`, `detected_at`. Never fulfil an order from this event; it exists so you
can decide on a refund.

`computeWebhookSignature(rawBody, secret)` returns the signature the
dispatcher would send — handy for test fixtures.

## Address derivation helpers

`deriveBip84Address`, `parseExtendedPublicKey`, `deriveBitcoinAddress`,
`deriveEthereumAddress` and friends (package root) derive receive addresses
from an extended **public** key. They are what the listener does internally and
are useful for checking an address independently.

## Legacy exports (deprecated)

Everything written for the pre-pivot Solana / x402 product is still exported
from the package root and from `@zettapay/sdk/server` so existing code keeps
compiling, and is marked `@deprecated`. None of it works against the current
listener or Cloud:

- `ZettaPayClient` and `client.invoices` (`InvoicesResource`) — call routes
  that are no longer served.
- `parseWebhook` and `verifyWebhookSignature` / `parseEvent` /
  `ZettaPayEventSchema` — expect a different signature input, timestamp unit
  and payload envelope, and reject every real delivery. Use `verifyWebhook`.
- The Solana helpers (`createMerchant`, `createInvoice`, `getInvoiceStatus`,
  `listenPaymentEvents`, `sweep`, the Anchor / PDA helpers, Solana Pay URI and
  QR helpers).

They will be removed in a future major version.

## License

MIT
