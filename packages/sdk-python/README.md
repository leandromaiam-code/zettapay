# ZettaPay Python SDK

Official Python SDK for the [ZettaPay](https://github.com/leandromaiam-code/zettapay) Solana payment protocol.

- Native Python types (`@dataclass`) for every API resource
- **Sync and async** clients sharing the same surface
- Built-in retries with exponential backoff + full jitter on idempotent ops
- Typed error envelope (`ZettaPayError`) mirroring the API contract
- **Zero runtime dependencies** — standard library only
- Type hints + `py.typed` marker — works out of the box with mypy / pyright

## Install

```bash
pip install zettapay
```

Requires Python 3.9+.

## Quick start (sync)

```python
from zettapay import RetryPolicy, ZettaPayClient

client = ZettaPayClient(
    "https://api.zettapay.dev",
    api_key="zp_live_...",
    retry=RetryPolicy.default(),
)

merchant = client.register_merchant(
    name="Acme Coffee",
    wallet_pubkey="7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
    usdc_ata="EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK",
)
print(f"merchant id={merchant.id} created at {merchant.created_at}")

receipt = client.pay(signed_solana_tx_bytes)
print(f"payment {receipt.payment_id} accepted={receipt.accepted}")
```

## Quick start (async)

```python
import asyncio
from zettapay import AsyncZettaPayClient

async def main():
    async with AsyncZettaPayClient("https://api.zettapay.dev", api_key="zp_live_...") as client:
        # Fan out concurrent reads — no thread management needed
        health, payments = await asyncio.gather(
            client.health(),
            client.list_payments(limit=20),
        )
        print(health.status, payments.total)

asyncio.run(main())
```

The async client wraps the sync client with `asyncio.to_thread`, keeping the
SDK dependency-free while exposing a coroutine-friendly surface for FastAPI,
AI agent tool calls, and other async runtimes.

## API surface

| Method | HTTP | Description |
| --- | --- | --- |
| `pay(transaction)` | `POST /pay` | Submit raw bytes (auto base64) or pre-encoded base64 string via `x-402-payment` header. |
| `register_merchant(...)` | `POST /merchants` | Create a merchant. |
| `get_merchant(id)` | `GET /merchants/:id` | Fetch a merchant. |
| `list_merchants(limit, offset)` | `GET /merchants` | Paginated list. |
| `update_merchant(id, ...)` | `PATCH /merchants/:id` | Patch a merchant (only set fields are sent). |
| `delete_merchant(id)` | `DELETE /merchants/:id` | Remove a merchant. |
| `get_payment(id)` | `GET /payments/:id` | Fetch a recorded payment. |
| `list_payments(limit, offset)` | `GET /payments` | Paginated list. |
| `health()` | `GET /healthz` | Liveness probe. |

Both `ZettaPayClient` and `AsyncZettaPayClient` expose the identical method
surface (snake_case for Python) — the async variant returns coroutines.

## Errors

Every method raises `ZettaPayError` on non-2xx responses or transport failures:

```python
from zettapay import ZettaPayError, is_code, is_status

try:
    client.get_merchant(99)
except ZettaPayError as err:
    if is_code(err, "not_found"):
        ...
    if is_status(err, 429):
        ...
    print(err.code, err.status_code, err.details, err.message)
```

`ZettaPayError` exposes:

- `code` — API error code or `"network_error"` / `"timeout"` for transport.
- `message` — human-readable explanation from the API body when available.
- `status_code` — HTTP status, or `None` for transport failures.
- `details` — optional structured payload (validation problems, etc.).
- `is_retryable()` — convenience helper used by the retry loop.

## Retries

Pass a `RetryPolicy` to the client constructor to enable retries:

```python
from zettapay import RetryPolicy, ZettaPayClient

client = ZettaPayClient(
    "https://api.zettapay.dev",
    retry=RetryPolicy.default(),  # 3 attempts, 100ms → 2s exp backoff w/ full jitter
)

# Or fully custom:
client = ZettaPayClient(
    "https://api.zettapay.dev",
    retry=RetryPolicy(max_attempts=5, initial_backoff=0.2, max_backoff=5.0),
)
```

Retries are applied **only to idempotent operations**: `GET`, `DELETE`, and
the liveness probe. Non-idempotent writes (`POST /pay`, `POST /merchants`,
`PATCH /merchants/:id`) execute exactly once.

Retryable conditions:

- Transport / network errors (DNS, dial, read, timeout)
- HTTP 429 (rate-limited)
- HTTP 5xx (server-side transient failure)

## X-402 payments

`pay()` sets the `x-402-payment` request header per the open
[x402 spec](https://github.com/coinbase/x402). Pass either:

- Raw signed Solana transaction bytes (`bytes` / `bytearray` / `memoryview`)
  — the SDK base64-encodes for you.
- A pre-encoded base64 `str`.

```python
signed: bytes = build_and_sign_transaction()
receipt = client.pay(signed)
```

## Testing

```bash
cd packages/sdk-python
pip install -e ".[test]"
pytest
```

The test suite spins up a real HTTP server via `http.server` — no mocking,
no recording fixtures.

## License

MIT — see repository root.
