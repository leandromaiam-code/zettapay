"""Official Python SDK for the ZettaPay Solana payment protocol.

Sync + async clients, x402 payments, zero runtime dependencies.

Quick start::

    from zettapay import ZettaPayClient, RetryPolicy

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

Async usage::

    from zettapay import AsyncZettaPayClient

    async with AsyncZettaPayClient("https://api.zettapay.dev") as client:
        receipt = await client.pay(signed_tx_bytes)
"""

from .async_client import AsyncZettaPayClient
from .client import X402_HEADER, TransactionInput, ZettaPayClient
from .errors import ZettaPayError, is_code, is_status
from .types import (
    HealthStatus,
    ListMerchantsResponse,
    ListPaymentsResponse,
    Merchant,
    PayResponse,
    PaymentRecord,
    RetryPolicy,
)

__version__ = "1.0.0"

__all__ = [
    "AsyncZettaPayClient",
    "HealthStatus",
    "ListMerchantsResponse",
    "ListPaymentsResponse",
    "Merchant",
    "PayResponse",
    "PaymentRecord",
    "RetryPolicy",
    "TransactionInput",
    "X402_HEADER",
    "ZettaPayClient",
    "ZettaPayError",
    "__version__",
    "is_code",
    "is_status",
]
