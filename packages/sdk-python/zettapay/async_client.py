from __future__ import annotations

import asyncio
from typing import Mapping, Optional

from .client import TransactionInput, ZettaPayClient
from .types import (
    HealthStatus,
    ListMerchantsResponse,
    ListPaymentsResponse,
    Merchant,
    PayResponse,
    PaymentRecord,
    RetryPolicy,
)


class AsyncZettaPayClient:
    """Async ZettaPay API client.

    Wraps :class:`ZettaPayClient` and dispatches each call to a worker thread
    via :func:`asyncio.to_thread`. This keeps the SDK dependency-free while
    providing a coroutine-friendly surface for ``async``/``await`` code paths
    (FastAPI, AI agent tool calls, etc.).

    Construction accepts the same arguments as the sync client. Use as a
    context manager (``async with AsyncZettaPayClient(...) as client:``) or
    call :meth:`close` explicitly when done.
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
        self._inner = ZettaPayClient(
            base_url,
            api_key=api_key,
            timeout=timeout,
            retry=retry,
            headers=headers,
            user_agent=user_agent,
        )

    async def __aenter__(self) -> "AsyncZettaPayClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def close(self) -> None:
        """Release any resources. Safe to call multiple times."""
        return None

    async def health(self) -> HealthStatus:
        return await asyncio.to_thread(self._inner.health)

    async def register_merchant(
        self,
        *,
        name: str,
        wallet_pubkey: str,
        usdc_ata: str,
    ) -> Merchant:
        return await asyncio.to_thread(
            self._inner.register_merchant,
            name=name,
            wallet_pubkey=wallet_pubkey,
            usdc_ata=usdc_ata,
        )

    async def get_merchant(self, merchant_id: int) -> Merchant:
        return await asyncio.to_thread(self._inner.get_merchant, merchant_id)

    async def list_merchants(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> ListMerchantsResponse:
        return await asyncio.to_thread(
            self._inner.list_merchants, limit=limit, offset=offset
        )

    async def update_merchant(
        self,
        merchant_id: int,
        *,
        name: Optional[str] = None,
        wallet_pubkey: Optional[str] = None,
        usdc_ata: Optional[str] = None,
    ) -> Merchant:
        return await asyncio.to_thread(
            self._inner.update_merchant,
            merchant_id,
            name=name,
            wallet_pubkey=wallet_pubkey,
            usdc_ata=usdc_ata,
        )

    async def delete_merchant(self, merchant_id: int) -> None:
        return await asyncio.to_thread(self._inner.delete_merchant, merchant_id)

    async def pay(self, transaction: TransactionInput) -> PayResponse:
        return await asyncio.to_thread(self._inner.pay, transaction)

    async def get_payment(self, payment_id: str) -> PaymentRecord:
        return await asyncio.to_thread(self._inner.get_payment, payment_id)

    async def list_payments(
        self,
        *,
        limit: Optional[int] = None,
        offset: Optional[int] = None,
    ) -> ListPaymentsResponse:
        return await asyncio.to_thread(
            self._inner.list_payments, limit=limit, offset=offset
        )
