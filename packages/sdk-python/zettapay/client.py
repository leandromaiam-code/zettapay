from __future__ import annotations

import base64
import json
import urllib.parse
from typing import Any, Dict, Mapping, Optional, Union

from . import _http
from .errors import ZettaPayError
from .invoices import Invoices
from .types import (
    HealthStatus,
    ListMerchantsResponse,
    ListPaymentsResponse,
    Merchant,
    PayResponse,
    PaymentRecord,
    RetryPolicy,
)

X402_HEADER = "x-402-payment"

TransactionInput = Union[bytes, bytearray, memoryview, str]


def _encode_transaction(transaction: TransactionInput) -> str:
    if isinstance(transaction, str):
        s = transaction.strip()
        if not s:
            raise ZettaPayError("transaction is required", "validation_error")
        return s
    if isinstance(transaction, (bytes, bytearray, memoryview)):
        raw = bytes(transaction)
        if not raw:
            raise ZettaPayError("transaction is required", "validation_error")
        return base64.b64encode(raw).decode("ascii")
    raise ZettaPayError(
        "transaction must be bytes or a base64 string",
        "validation_error",
    )


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise ZettaPayError(message, "validation_error")


class ZettaPayClient:
    """Synchronous ZettaPay API client.

    Thread-safe: a single client instance can be shared across threads. Built
    on Python's standard library — zero runtime dependencies.

    Args:
        base_url: API origin (e.g. ``https://api.zettapay.dev``).
        api_key: optional bearer token attached as ``Authorization: Bearer <key>``.
        timeout: per-request timeout in seconds (default 10).
        retry: ``RetryPolicy`` for idempotent requests. Defaults to disabled.
        headers: extra headers attached to every request.
        user_agent: override the default User-Agent.
    """

    def __init__(
        self,
        base_url: str,
        *,
        api_key: Optional[str] = None,
        timeout: float = 10.0,
        retry: Optional[RetryPolicy] = None,
        headers: Optional[Mapping[str, str]] = None,
        user_agent: Optional[str] = None,
    ) -> None:
        if not base_url or not isinstance(base_url, str):
            raise ZettaPayError("base_url is required", "validation_error")
        self._base_url = base_url.strip().rstrip("/")
        if not self._base_url:
            raise ZettaPayError("base_url is required", "validation_error")
        self._api_key = api_key.strip() if api_key else None
        self._timeout = float(timeout) if timeout and timeout > 0 else 10.0
        self._retry = retry or RetryPolicy.disabled()
        self._user_agent = user_agent or _http.USER_AGENT
        self._extra_headers: Dict[str, str] = dict(headers or {})
        self.invoices = Invoices(self)

    # ---- public surface --------------------------------------------------

    def health(self) -> HealthStatus:
        """``GET /healthz`` — liveness probe (idempotent, retried)."""
        data = self._request("GET", "/healthz", retryable=True)
        return HealthStatus.from_api(data)

    def register_merchant(
        self,
        *,
        name: str,
        wallet_pubkey: str,
        usdc_ata: str,
    ) -> Merchant:
        """``POST /merchants`` — create a merchant. Non-idempotent (no retry)."""
        _require(bool(name), "name is required")
        _require(bool(wallet_pubkey), "wallet_pubkey is required")
        _require(bool(usdc_ata), "usdc_ata is required")
        body = {
            "name": name,
            "wallet_pubkey": wallet_pubkey,
            "usdc_ata": usdc_ata,
        }
        data = self._request("POST", "/merchants", body=body)
        return Merchant.from_api(data)

    def get_merchant(self, merchant_id: int) -> Merchant:
        """``GET /merchants/:id`` — fetch a merchant."""
        path = f"/merchants/{int(merchant_id)}"
        data = self._request("GET", path, retryable=True)
        return Merchant.from_api(data)

    def list_merchants(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> ListMerchantsResponse:
        """``GET /merchants`` — paginated list."""
        query = _build_pagination(limit, offset)
        data = self._request("GET", "/merchants", query=query, retryable=True)
        return ListMerchantsResponse.from_api(data)

    def update_merchant(
        self,
        merchant_id: int,
        *,
        name: Optional[str] = None,
        wallet_pubkey: Optional[str] = None,
        usdc_ata: Optional[str] = None,
    ) -> Merchant:
        """``PATCH /merchants/:id`` — patch a merchant. Non-idempotent (no retry)."""
        body: Dict[str, Any] = {}
        if name is not None:
            body["name"] = name
        if wallet_pubkey is not None:
            body["wallet_pubkey"] = wallet_pubkey
        if usdc_ata is not None:
            body["usdc_ata"] = usdc_ata
        path = f"/merchants/{int(merchant_id)}"
        data = self._request("PATCH", path, body=body)
        return Merchant.from_api(data)

    def delete_merchant(self, merchant_id: int) -> None:
        """``DELETE /merchants/:id`` — remove a merchant. Idempotent (retried)."""
        path = f"/merchants/{int(merchant_id)}"
        self._request("DELETE", path, retryable=True, expect_body=False)

    def pay(self, transaction: TransactionInput) -> PayResponse:
        """``POST /pay`` — submit a signed Solana transaction via the
        ``x-402-payment`` header. Accepts raw bytes (auto base64-encoded) or a
        pre-encoded base64 string. Non-idempotent (no retry)."""
        encoded = _encode_transaction(transaction)
        data = self._request(
            "POST",
            "/pay",
            extra_headers={X402_HEADER: encoded},
        )
        return PayResponse.from_api(data)

    def get_payment(self, payment_id: str) -> PaymentRecord:
        """``GET /payments/:id`` — fetch a recorded payment."""
        if not isinstance(payment_id, str) or not payment_id.strip():
            raise ZettaPayError("payment_id is required", "validation_error")
        path = f"/payments/{urllib.parse.quote(payment_id.strip(), safe='')}"
        data = self._request("GET", path, retryable=True)
        return PaymentRecord.from_api(data)

    def list_payments(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> ListPaymentsResponse:
        """``GET /payments`` — paginated list."""
        query = _build_pagination(limit, offset)
        data = self._request("GET", "/payments", query=query, retryable=True)
        return ListPaymentsResponse.from_api(data)

    # ---- internals -------------------------------------------------------

    def _build_headers(
        self, extra: Optional[Mapping[str, str]] = None, *, with_body: bool = False
    ) -> Dict[str, str]:
        headers: Dict[str, str] = {
            "User-Agent": self._user_agent,
            "Accept": "application/json",
        }
        if with_body:
            headers["Content-Type"] = "application/json"
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        for k, v in self._extra_headers.items():
            headers[k] = v
        if extra:
            for k, v in extra.items():
                headers[k] = v
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        query: Optional[Mapping[str, Any]] = None,
        extra_headers: Optional[Mapping[str, str]] = None,
        retryable: bool = False,
        expect_body: bool = True,
    ) -> Dict[str, Any]:
        url = _http.join_url(self._base_url, path, query)
        encoded_body: Optional[bytes] = None
        if body is not None:
            encoded_body = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers = self._build_headers(extra_headers, with_body=encoded_body is not None)
        status, payload = _http.request(
            method=method,
            url=url,
            headers=headers,
            body=encoded_body,
            timeout=self._timeout,
            retry=self._retry,
            retryable=retryable,
        )
        if not expect_body or status == 204 or not payload:
            return {}
        return _http.decode_json(payload)


def _build_pagination(
    limit: Optional[int], offset: Optional[int]
) -> Dict[str, Any]:
    query: Dict[str, Any] = {}
    if limit is not None:
        query["limit"] = int(limit)
    if offset is not None:
        query["offset"] = int(offset)
    return query
