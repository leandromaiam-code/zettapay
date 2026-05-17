"""Multi-chain invoice surface (Z52).

ZettaPay watches BTC + USDC across EVM (Base / Polygon / Ethereum). Customers
send to a per-invoice receive address derived by Z45's HD wallet allocator;
the listener detects the inbound tx and fires the webhook.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Mapping, Optional

from .errors import ZettaPayError

if TYPE_CHECKING:
    from .client import ZettaPayClient

SUPPORTED_CHAINS: tuple[str, ...] = ("btc", "base", "polygon", "ethereum")
"""Tuple of chains accepted by ``POST /api/invoices``."""


def is_supported_chain(value: Any) -> bool:
    return isinstance(value, str) and value in SUPPORTED_CHAINS


def normalize_webhook_chain(value: Any) -> str:
    """Return the chain string, or ``'unknown'`` for legacy/missing payloads."""
    if is_supported_chain(value):
        return value
    return "unknown"


@dataclass(frozen=True)
class Invoice:
    invoice_id: str
    chain: str
    receive_address: str
    amount_usd: float
    amount_native: str
    qr_uri: str
    expires_at: int
    status: str
    verify_url: str
    merchant_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None

    @classmethod
    def from_api(cls, data: Mapping[str, Any]) -> "Invoice":
        return cls(
            invoice_id=str(data.get("invoice_id", data.get("invoiceId", ""))),
            chain=normalize_webhook_chain(data.get("chain")),
            receive_address=str(
                data.get("receive_address", data.get("receiveAddress", ""))
            ),
            amount_usd=float(data.get("amount_usd", data.get("amountUsd", 0))),
            amount_native=str(
                data.get("amount_native", data.get("amountNative", ""))
            ),
            qr_uri=str(data.get("qr_uri", data.get("qrUri", ""))),
            expires_at=int(data.get("expires_at", data.get("expiresAt", 0))),
            status=str(data.get("status", "pending")),
            verify_url=str(data.get("verify_url", data.get("verifyUrl", ""))),
            merchant_id=(
                str(data["merchant_id"])
                if data.get("merchant_id") is not None
                else (
                    str(data["merchantId"])
                    if data.get("merchantId") is not None
                    else None
                )
            ),
            metadata=(
                dict(data["metadata"])
                if isinstance(data.get("metadata"), Mapping)
                else None
            ),
        )


@dataclass(frozen=True)
class WebhookInvoicePayload:
    invoice_id: str
    status: str
    chain: str  # one of SUPPORTED_CHAINS or "unknown" for legacy events
    tx_hash: Optional[str]
    amount_native: str
    confirmations: int
    receive_address: str
    merchant_id: str
    metadata: Optional[Dict[str, Any]] = field(default=None)

    @classmethod
    def from_api(cls, data: Mapping[str, Any]) -> "WebhookInvoicePayload":
        tx_hash = data.get("tx_hash", data.get("txHash"))
        return cls(
            invoice_id=str(data.get("invoice_id", data.get("invoiceId", ""))),
            status=str(data.get("status", "")),
            chain=normalize_webhook_chain(data.get("chain")),
            tx_hash=str(tx_hash) if tx_hash else None,
            amount_native=str(
                data.get("amount_native", data.get("amountNative", ""))
            ),
            confirmations=int(data.get("confirmations", 0)),
            receive_address=str(
                data.get("receive_address", data.get("receiveAddress", ""))
            ),
            merchant_id=str(data.get("merchant_id", data.get("merchantId", ""))),
            metadata=(
                dict(data["metadata"])
                if isinstance(data.get("metadata"), Mapping)
                else None
            ),
        )


class Invoices:
    """``client.invoices`` namespace — multi-chain invoice CRUD.

    Example::

        invoice = client.invoices.create(amount_usd=29, chain="base")
        print(invoice.receive_address, invoice.amount_native)
    """

    def __init__(self, client: "ZettaPayClient") -> None:
        self._client = client

    def create(
        self,
        *,
        amount_usd: float,
        chain: str,
        merchant_id: Optional[str] = None,
        ttl_seconds: Optional[int] = None,
        metadata: Optional[Mapping[str, Any]] = None,
    ) -> Invoice:
        if not isinstance(amount_usd, (int, float)) or amount_usd <= 0:
            raise ZettaPayError(
                "invoices.create: amount_usd must be a positive number",
                "validation_error",
            )
        if not is_supported_chain(chain):
            raise ZettaPayError(
                f"invoices.create: chain must be one of {', '.join(SUPPORTED_CHAINS)} "
                f"(got {chain!r})",
                "validation_error",
            )
        body: Dict[str, Any] = {"amount_usd": amount_usd, "chain": chain}
        if merchant_id is not None:
            body["merchant_id"] = merchant_id
        if ttl_seconds is not None:
            body["ttl_seconds"] = int(ttl_seconds)
        if metadata is not None:
            body["metadata"] = dict(metadata)
        data = self._client._request("POST", "/api/invoices", body=body)
        return Invoice.from_api(data)

    def get(self, invoice_id: str) -> Invoice:
        if not isinstance(invoice_id, str) or not invoice_id.strip():
            raise ZettaPayError("invoices.get: invoice_id is required", "validation_error")
        path = f"/api/invoices/{invoice_id.strip()}"
        data = self._client._request("GET", path, retryable=True)
        return Invoice.from_api(data)


__all__: List[str] = [
    "SUPPORTED_CHAINS",
    "Invoice",
    "Invoices",
    "WebhookInvoicePayload",
    "is_supported_chain",
    "normalize_webhook_chain",
]
