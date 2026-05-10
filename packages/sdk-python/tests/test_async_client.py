from __future__ import annotations

import asyncio
from typing import Any, Dict, Tuple

import pytest

from tests.conftest import FakeApiServer, RecordedRequest
from zettapay import AsyncZettaPayClient, X402_HEADER, ZettaPayError


@pytest.fixture
def fake_server():
    state: Dict[str, Any] = {"handler": lambda req: (404, {"error": {"code": "no_handler", "message": "missing"}}, None)}

    def dispatch(req: RecordedRequest) -> Tuple[int, Any, Any]:
        return state["handler"](req)

    server = FakeApiServer(handler=dispatch).start()
    try:
        yield server, state
    finally:
        server.stop()


def _async_test(coro):
    asyncio.run(coro)


def test_async_health(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (200, {"status": "ok", "merchants": 1, "payments": 2}, None)

    async def run():
        async with AsyncZettaPayClient(server.base_url, timeout=5.0) as client:
            got = await client.health()
            assert got.status == "ok"
            assert got.merchants == 1
            assert got.payments == 2

    _async_test(run())


def test_async_register_and_pay(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        if req.method == "POST" and req.path == "/merchants":
            return 201, {
                "id": 1, "name": "n",
                "walletPubkey": "p", "usdcAta": "u", "createdAt": 1,
            }, None
        if req.method == "POST" and req.path == "/pay":
            x402 = req.headers.get(X402_HEADER) or req.headers.get(X402_HEADER.title())
            assert x402 == "AAEC"
            return 200, {
                "accepted": True, "paymentId": "pay_a",
                "feePayer": "FP", "signers": [], "signatureCount": 1,
                "recentBlockhash": "BH", "isVersioned": False,
                "version": None, "transactionBytes": 3,
            }, None
        return 404, {"error": {"code": "no", "message": "no"}}, None

    state["handler"] = handler

    async def run():
        async with AsyncZettaPayClient(server.base_url, timeout=5.0) as client:
            merchant = await client.register_merchant(
                name="n", wallet_pubkey="p", usdc_ata="u"
            )
            assert merchant.id == 1
            receipt = await client.pay("AAEC")
            assert receipt.accepted
            assert receipt.payment_id == "pay_a"

    _async_test(run())


def test_async_concurrent_requests(fake_server):
    """Async client should support concurrent execution via gather()."""
    server, state = fake_server
    state["handler"] = lambda req: (200, {"status": "ok", "merchants": 0, "payments": 0}, None)

    async def run():
        async with AsyncZettaPayClient(server.base_url, timeout=5.0) as client:
            results = await asyncio.gather(
                client.health(), client.health(), client.health()
            )
            assert all(r.status == "ok" for r in results)
            assert len(server.requests) == 3

    _async_test(run())


def test_async_propagates_errors(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (
        404,
        {"error": {"code": "not_found", "message": "missing"}},
        None,
    )

    async def run():
        async with AsyncZettaPayClient(server.base_url, timeout=5.0) as client:
            with pytest.raises(ZettaPayError) as exc_info:
                await client.get_merchant(99)
            assert exc_info.value.code == "not_found"
            assert exc_info.value.status_code == 404

    _async_test(run())


def test_async_list_payments(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        assert req.path == "/payments"
        assert req.query.get("limit") == ["10"]
        return 200, {
            "items": [{
                "id": "p1", "feePayer": "fp", "signers": [], "signatures": [],
                "recentBlockhash": "", "isVersioned": False, "version": None,
                "transactionBytes": 0, "acceptedAt": 0,
            }],
            "count": 1, "total": 1,
        }, None

    state["handler"] = handler

    async def run():
        async with AsyncZettaPayClient(server.base_url, timeout=5.0) as client:
            res = await client.list_payments(limit=10)
            assert res.total == 1
            assert res.items[0].id == "p1"

    _async_test(run())
