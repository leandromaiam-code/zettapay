# ZettaPay PHP SDK

Official PHP SDK for the [ZettaPay](https://github.com/leandromaiam-code/zettapay) Solana payment protocol.

- PSR-7 / PSR-17 / PSR-18 native — bring any compliant HTTP stack (Guzzle, Symfony HttpClient, cURL)
- Auto-discovery of HTTP client when no explicit instances are passed
- Factory methods (`Client::create`, `ClientConfig::create`) for ergonomic construction
- Strongly-typed models (readonly DTOs), value-object configuration, immutable retry policy
- Built-in retries with exponential backoff + full jitter on idempotent operations
- Typed errors (`ApiException`, `NetworkException`) mirroring the API envelope
- x402 payment header (`x-402-payment`) support via `Client::pay()`

## Install

```bash
composer require zettapay/sdk
```

You also need a PSR-18 HTTP client and PSR-17 factories. Pick one:

```bash
# Option A — Guzzle (most common)
composer require guzzlehttp/guzzle

# Option B — Symfony HttpClient
composer require symfony/http-client nyholm/psr7
```

Auto-discovery (`php-http/discovery`) picks up whichever is installed.

Requires PHP 8.1 or later.

## Quick start

```php
<?php

use ZettaPay\Client;
use ZettaPay\RetryPolicy;

$client = Client::create(
    baseUrl: 'https://api.zettapay.dev',
    apiKey: 'zp_live_...',
    retry: RetryPolicy::default(),
);

$merchant = $client->merchants->register(
    name: 'Acme Coffee',
    walletPubkey: '7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT',
    usdcAta: 'EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK',
);

printf("merchant id=%d created at %d\n", $merchant->id, $merchant->createdAt);
```

## API surface

| Method | HTTP | Description |
| --- | --- | --- |
| `$c->pay(string)` | `POST /pay` | Submit a signed transaction (base64 string or raw bytes) via `x-402-payment` header. |
| `$c->merchants->register(name, pubkey, ata)` | `POST /merchants` | Create a merchant. |
| `$c->merchants->get(id)` | `GET /merchants/:id` | Fetch a merchant. |
| `$c->merchants->list(limit, offset)` | `GET /merchants` | Paginated merchant list. |
| `$c->merchants->update(id, ...)` | `PATCH /merchants/:id` | Patch a merchant. |
| `$c->merchants->delete(id)` | `DELETE /merchants/:id` | Remove a merchant. |
| `$c->payments->get(id)` | `GET /payments/:id` | Fetch a recorded payment. |
| `$c->payments->list(limit, offset)` | `GET /payments` | Paginated payment list. |
| `$c->health()` | `GET /healthz` | Liveness probe. |
| `$c->invoices->create(...)` | `POST /api/invoices` | Multi-chain invoice (BTC / Base / Polygon / Ethereum). |
| `$c->invoices->get(id)` | `GET /api/invoices/:id` | Fetch a multi-chain invoice. |

### Multi-chain invoices

```php
$invoice = $client->invoices->create(
    amountUsd: 29,
    chain: 'base', // 'btc' | 'base' | 'polygon' | 'ethereum'
    metadata: ['order_id' => 'xyz'],
);
echo $invoice->receiveAddress, ' ', $invoice->amountNative, PHP_EOL;
```

Webhook payloads on multi-chain invoices include a `chain` field. Legacy
events resolve to `'unknown'` via `Invoice::normalizeWebhookChain()`.

## Bring your own HTTP stack

Pass any PSR-18 client and PSR-17 factories explicitly to skip discovery:

```php
use GuzzleHttp\Client as GuzzleClient;
use GuzzleHttp\Psr7\HttpFactory;
use ZettaPay\Client;
use ZettaPay\ClientConfig;

$guzzle = new GuzzleClient(['timeout' => 10]);
$factory = new HttpFactory();

$client = new Client(new ClientConfig(
    baseUrl: 'https://api.zettapay.dev',
    apiKey: getenv('ZETTAPAY_API_KEY') ?: null,
    httpClient: $guzzle,
    requestFactory: $factory,
    streamFactory: $factory,
));
```

## Errors

All API failures throw `ZettaPay\Exception\ApiException`; transport failures
throw `ZettaPay\Exception\NetworkException`. Both extend `ZettaPayException`.

```php
use ZettaPay\Exception\ApiException;

try {
    $client->merchants->get(999);
} catch (ApiException $e) {
    if ($e->errorCode === 'not_found') {
        // 404
    }
    if ($e->statusCode === 429) {
        // rate limited
    }
}
```

`ApiException::isRetryable()` and `NetworkException::isRetryable()` mirror
the SDK's own retry classification.

## Retries

```php
use ZettaPay\RetryPolicy;

$retry = RetryPolicy::default();              // 3 attempts, 100ms → 2s, full jitter
$retry = new RetryPolicy(maxAttempts: 5, initialBackoffMs: 50, maxBackoffMs: 1500);
$retry = RetryPolicy::disabled();             // explicit no-retry
```

Retries are applied **only to idempotent operations** — `GET`, `DELETE`, and
the liveness probe. Non-idempotent writes (`POST /pay`, `POST /merchants`,
`PATCH /merchants/:id`) execute exactly once.

Retryable conditions: transport / network errors, HTTP 429, HTTP 5xx.

## X-402 payments

`pay()` sets the `x-402-payment` request header per the open
[x402 spec](https://github.com/coinbase/x402). Pass either:

- A raw signed Solana transaction (PHP `string` of binary bytes) — the SDK
  base64-encodes it.
- A pre-encoded base64 string — passed through unchanged.

```php
$signed = buildAndSignTransaction(); // raw bytes
$receipt = $client->pay($signed);
echo $receipt->paymentId;
```

## Testing

```bash
cd packages/sdk-php
composer install
composer exec phpunit
```

Tests use a fake PSR-18 client and Guzzle's PSR-17 factories; no network is
touched.

## License

MIT — see repository root.
