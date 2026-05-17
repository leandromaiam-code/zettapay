# ZettaPay Rust SDK

Official Rust SDK for the [ZettaPay](https://github.com/leandromaiam-code/zettapay) Solana payment protocol.

- Async-first via `tokio` + `reqwest`
- Strongly-typed `serde` models for every API resource
- Builder pattern (`Client::builder()`) for ergonomic configuration
- Typed `Error` envelope mirroring the API contract
- Built-in retries with exponential backoff + full jitter

## Install

```bash
cargo add zettapay
```

Or in `Cargo.toml`:

```toml
[dependencies]
zettapay = "0.1"
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

Requires Rust 1.75 or later.

## Quick start

```rust
use std::time::Duration;
use zettapay::{Client, RegisterMerchantInput, RetryPolicy};

#[tokio::main]
async fn main() -> Result<(), zettapay::Error> {
    let client = Client::builder()
        .base_url("https://api.zettapay.dev")
        .api_key("zp_live_...")
        .timeout(Duration::from_secs(10))
        .retry(RetryPolicy::default_policy())
        .build()?;

    let merchant = client
        .register_merchant(RegisterMerchantInput {
            name: "Acme Coffee".into(),
            wallet_pubkey: "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT".into(),
            usdc_ata: "EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK".into(),
        })
        .await?;
    println!("merchant id={} createdAt={}", merchant.id, merchant.created_at);
    Ok(())
}
```

## API surface

| Method | HTTP | Description |
| --- | --- | --- |
| `pay(&[u8])` | `POST /pay` | Submit raw signed transaction bytes via `x-402-payment` header. |
| `pay_base64(&str)` | `POST /pay` | Submit a pre-encoded base64 transaction. |
| `register_merchant(input)` | `POST /merchants` | Create a merchant. |
| `get_merchant(id)` | `GET /merchants/:id` | Fetch a merchant. |
| `list_merchants(opts)` | `GET /merchants` | Paginated merchant list. |
| `update_merchant(id, patch)` | `PATCH /merchants/:id` | Patch a merchant. |
| `delete_merchant(id)` | `DELETE /merchants/:id` | Remove a merchant. |
| `get_payment(id)` | `GET /payments/:id` | Fetch a recorded payment. |
| `list_payments(opts)` | `GET /payments` | Paginated payment list. |
| `health()` | `GET /healthz` | Liveness probe. |
| `create_invoice(input)` | `POST /api/invoices` | Multi-chain invoice (BTC / Base / Polygon / Ethereum). |

### Multi-chain invoices

```rust
use zettapay::{Chain, CreateInvoiceInput};

let invoice = client
    .create_invoice(CreateInvoiceInput {
        amount_usd: 29.0,
        chain: Chain::Base, // Chain::Btc | Chain::Base | Chain::Polygon | Chain::Ethereum
        merchant_id: None,
        ttl_seconds: None,
        metadata: Some(serde_json::json!({ "order_id": "xyz" })),
    })
    .await?;
println!("{} {}", invoice.receive_address, invoice.amount_native);
```

Webhook payloads on multi-chain invoices include a `chain` field. Legacy
events deserialize to `WebhookChain::Unknown`.

## Errors

Every method returns `Result<T, zettapay::Error>` where `Error` mirrors the
API envelope:

```rust
pub struct Error {
    pub code: String,            // API code or "network_error" / "timeout" / "decode_error"
    pub message: String,
    pub status_code: Option<u16>,// None for transport failures
    pub details: Option<serde_json::Value>,
}
```

Idiomatic checks:

```rust
match client.get_merchant(42).await {
    Ok(m) => { /* ... */ }
    Err(err) if err.is_code("not_found") => { /* 404 */ }
    Err(err) if err.is_status(429) => { /* rate limited */ }
    Err(err) => return Err(err),
}
```

## Retries

`RetryPolicy::default_policy()` gives 3 attempts, 100 ms → 2 s exponential
backoff with full jitter. Retries are applied **only to idempotent
operations**: `GET`, `DELETE`, and the liveness probe. Non-idempotent writes
(`POST /pay`, `POST /merchants`, `PATCH /merchants/:id`) execute exactly
once.

Retryable conditions:

- Transport / network errors (DNS, dial, read)
- HTTP 429 (rate-limited)
- HTTP 5xx (server-side transient failure)

## X-402 payments

`pay()` and `pay_base64()` set the `x-402-payment` request header per the
open [x402 spec](https://github.com/coinbase/x402). Pass either:

- Raw signed Solana transaction bytes (`&[u8]`) — the SDK base64-encodes them.
- A pre-encoded base64 string via `pay_base64`.

```rust
let signed: Vec<u8> = build_and_sign_transaction();
let receipt = client.pay(&signed).await?;
```

## Testing

The SDK ships with mockito-driven integration tests:

```bash
cd packages/sdk-rust
cargo test
```

## License

MIT — see repository root.
