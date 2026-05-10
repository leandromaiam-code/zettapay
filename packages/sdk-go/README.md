# ZettaPay Go SDK

Official Go SDK for the [ZettaPay](https://github.com/leandromaiam-code/zettapay) Solana payment protocol.

- Native Go types for every API resource
- `context.Context` on every method (deadlines, cancellation)
- Built-in retries with exponential backoff + full jitter
- Typed error envelope (`*zettapay.Error`) mirroring the API contract
- Zero third-party dependencies — standard library only

## Install

```bash
go get github.com/leandromaiam-code/zettapay/packages/sdk-go
```

Then import as:

```go
import zettapay "github.com/leandromaiam-code/zettapay/packages/sdk-go"
```

Requires Go 1.22 or later.

## Quick start

```go
package main

import (
	"context"
	"log"
	"time"

	zettapay "github.com/leandromaiam-code/zettapay/packages/sdk-go"
)

func main() {
	client, err := zettapay.NewClient(zettapay.ClientConfig{
		BaseURL: "https://api.zettapay.dev",
		APIKey:  "zp_live_...",
		Retry:   zettapay.DefaultRetryPolicy(),
	})
	if err != nil {
		log.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	merchant, err := client.RegisterMerchant(ctx, zettapay.RegisterMerchantInput{
		Name:         "Acme Coffee",
		WalletPubkey: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
		UsdcATA:      "EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK",
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("merchant id=%d created at %d", merchant.ID, merchant.CreatedAt)
}
```

## API surface

| Method | HTTP | Description |
| --- | --- | --- |
| `Pay(ctx, []byte)` | `POST /pay` | Submit raw signed transaction bytes via `x-402-payment` header. |
| `PayBase64(ctx, string)` | `POST /pay` | Submit a pre-encoded base64 transaction. |
| `RegisterMerchant(ctx, input)` | `POST /merchants` | Create a merchant. |
| `GetMerchant(ctx, id)` | `GET /merchants/:id` | Fetch a merchant. |
| `ListMerchants(ctx, opts)` | `GET /merchants` | Paginated merchant list. |
| `UpdateMerchant(ctx, id, patch)` | `PATCH /merchants/:id` | Patch a merchant. |
| `DeleteMerchant(ctx, id)` | `DELETE /merchants/:id` | Remove a merchant. |
| `GetPayment(ctx, id)` | `GET /payments/:id` | Fetch a recorded payment. |
| `ListPayments(ctx, opts)` | `GET /payments` | Paginated payment list. |
| `Health(ctx)` | `GET /healthz` | Liveness probe. |

## Errors

Every method returns a `*zettapay.Error` on non-2xx responses or transport
failures. The error implements the standard `error` interface and exposes:

```go
type Error struct {
    Code       string // API error code or "network_error"/"timeout"/"canceled"
    Message    string
    StatusCode int    // 0 for transport failures
    Details    any    // optional structured payload (validation problems, etc.)
    Cause      error  // wrapped underlying error, if any
}
```

Idiomatic checks:

```go
if zettapay.IsCode(err, "not_found") {
    // 404
}
if zettapay.IsStatus(err, 429) {
    // rate limited
}

var zerr *zettapay.Error
if errors.As(err, &zerr) {
    fmt.Println(zerr.Code, zerr.StatusCode, zerr.Details)
}
```

## Retries

`ClientConfig.Retry` (default: disabled) controls retry behavior. Use
`zettapay.DefaultRetryPolicy()` for sane defaults (3 attempts, 100ms → 2s
exponential backoff with full jitter).

Retries are applied **only to idempotent operations**: `GET`, `DELETE`, and
the liveness probe. Non-idempotent writes (`POST /pay`, `POST /merchants`,
`PATCH /merchants/:id`) execute exactly once unless the API exposes
idempotency keys server-side.

Retryable conditions:

- Transport / network errors (DNS, dial, read)
- HTTP 429 (rate-limited)
- HTTP 5xx (server-side transient failure)

The retry loop respects `ctx.Done()` — cancelling the context exits
immediately with `context.Canceled`.

## X-402 payments

`Pay` and `PayBase64` set the `x-402-payment` request header, per the open
[x402 spec](https://github.com/coinbase/x402). Pass either:

- A raw signed Solana transaction (`[]byte`) — the SDK base64-encodes it.
- A pre-encoded base64 string via `PayBase64`.

```go
signed := buildAndSignTransaction()                  // []byte
receipt, err := client.Pay(ctx, signed)
```

## Testing

The SDK has zero external dependencies and its tests run against
`net/http/httptest`:

```bash
cd packages/sdk-go
go test ./...
```

## License

MIT — see repository root.
