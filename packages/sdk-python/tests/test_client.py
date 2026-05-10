from __future__ import annotations

import base64
from typing import Any, Dict, Tuple

import pytest

from tests.conftest import FakeApiServer, RecordedRequest
from zettapay import (
    RetryPolicy,
    X402_HEADER,
    ZettaPayClient,
    ZettaPayError,
    is_code,
    is_status,
)


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


def _client(server: FakeApiServer, **kwargs) -> ZettaPayClient:
    kwargs.setdefault("timeout", 5.0)
    return ZettaPayClient(server.base_url, **kwargs)


def test_validates_base_url():
    with pytest.raises(ZettaPayError):
        ZettaPayClient("")
    with pytest.raises(ZettaPayError):
        ZettaPayClient("   ")


def test_health_returns_typed_response(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (
        200,
        {"status": "ok", "merchants": 3, "payments": 7},
        None,
    )
    client = _client(server)
    got = client.health()
    assert got.status == "ok"
    assert got.merchants == 3
    assert got.payments == 7
    assert server.requests[-1].path == "/healthz"


def test_register_and_get_merchant(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        if req.method == "POST" and req.path == "/merchants":
            assert req.headers["Content-Type"] == "application/json"
            import json
            body = json.loads(req.body)
            assert body == {"name": "Acme", "wallet_pubkey": "PUB", "usdc_ata": "ATA"}
            return 201, {
                "id": 42, "name": "Acme",
                "walletPubkey": "PUB", "usdcAta": "ATA",
                "createdAt": 1700000000,
            }, None
        if req.method == "GET" and req.path == "/merchants/42":
            return 200, {
                "id": 42, "name": "Acme",
                "walletPubkey": "PUB", "usdcAta": "ATA",
                "createdAt": 1700000000,
            }, None
        return 404, {"error": {"code": "not_found", "message": "no"}}, None

    state["handler"] = handler
    client = _client(server)
    merchant = client.register_merchant(name="Acme", wallet_pubkey="PUB", usdc_ata="ATA")
    assert merchant.id == 42
    assert merchant.wallet_pubkey == "PUB"

    got = client.get_merchant(42)
    assert got.name == "Acme"
    assert got.usdc_ata == "ATA"


def test_register_merchant_validates_input(fake_server):
    server, _state = fake_server
    client = _client(server)
    with pytest.raises(ZettaPayError):
        client.register_merchant(name="", wallet_pubkey="p", usdc_ata="u")
    with pytest.raises(ZettaPayError):
        client.register_merchant(name="n", wallet_pubkey="", usdc_ata="u")
    with pytest.raises(ZettaPayError):
        client.register_merchant(name="n", wallet_pubkey="p", usdc_ata="")
    assert server.requests == []


def test_list_merchants_builds_query(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        assert req.path == "/merchants"
        assert req.query.get("limit") == ["5"]
        assert req.query.get("offset") == ["10"]
        return 200, {
            "items": [
                {"id": 1, "name": "a", "walletPubkey": "p", "usdcAta": "u", "createdAt": 1},
                {"id": 2, "name": "b", "walletPubkey": "p", "usdcAta": "u", "createdAt": 2},
            ],
            "count": 2,
        }, None

    state["handler"] = handler
    client = _client(server)
    res = client.list_merchants(limit=5, offset=10)
    assert res.count == 2
    assert [m.id for m in res.items] == [1, 2]


def test_update_omits_unset_fields(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        assert req.method == "PATCH"
        assert req.path == "/merchants/7"
        import json
        body = json.loads(req.body)
        assert body == {"name": "newname"}
        return 200, {"id": 7, "name": "newname", "walletPubkey": "p", "usdcAta": "u", "createdAt": 1}, None

    state["handler"] = handler
    client = _client(server)
    patched = client.update_merchant(7, name="newname")
    assert patched.name == "newname"


def test_delete_merchant_handles_no_content(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (204, None, None)
    client = _client(server)
    assert client.delete_merchant(7) is None
    assert server.requests[-1].method == "DELETE"
    assert server.requests[-1].path == "/merchants/7"


def test_pay_sends_x402_header_with_base64(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        assert req.path == "/pay"
        assert req.method == "POST"
        # http.server lowercases header keys when accessed but preserves case
        # in items; client sets exact "x-402-payment".
        x402 = req.headers.get(X402_HEADER) or req.headers.get(X402_HEADER.title())
        assert x402 == "AAEC"
        return 200, {
            "accepted": True, "paymentId": "pay_123",
            "feePayer": "FP", "signers": ["FP"], "signatureCount": 1,
            "recentBlockhash": "BH", "isVersioned": False,
            "version": None, "transactionBytes": 3,
        }, None

    state["handler"] = handler
    client = _client(server)
    res = client.pay("AAEC")
    assert res.accepted is True
    assert res.payment_id == "pay_123"


def test_pay_encodes_raw_bytes(fake_server):
    server, state = fake_server

    captured = {}

    def handler(req: RecordedRequest):
        captured["x402"] = req.headers.get(X402_HEADER) or req.headers.get(X402_HEADER.title())
        return 200, {
            "accepted": True, "paymentId": "p",
            "feePayer": "FP", "signers": [], "signatureCount": 0,
            "recentBlockhash": "BH", "isVersioned": False,
            "version": None, "transactionBytes": 3,
        }, None

    state["handler"] = handler
    client = _client(server)
    client.pay(b"\x01\x02\x03")
    assert captured["x402"] == base64.b64encode(b"\x01\x02\x03").decode("ascii")


def test_pay_validates_empty(fake_server):
    server, _state = fake_server
    client = _client(server)
    with pytest.raises(ZettaPayError):
        client.pay(b"")
    with pytest.raises(ZettaPayError):
        client.pay("")
    assert server.requests == []


def test_get_payment_validates_id(fake_server):
    server, _state = fake_server
    client = _client(server)
    with pytest.raises(ZettaPayError):
        client.get_payment("")


def test_payment_round_trip(fake_server):
    server, state = fake_server

    def handler(req: RecordedRequest):
        if req.path == "/payments/abc":
            return 200, {
                "id": "abc", "feePayer": "fp",
                "signers": ["fp"], "signatures": ["sig"],
                "recentBlockhash": "bh", "isVersioned": False,
                "version": None, "transactionBytes": 100,
                "acceptedAt": 1700000000,
            }, None
        if req.path == "/payments":
            return 200, {
                "items": [{
                    "id": "abc", "feePayer": "fp",
                    "signers": [], "signatures": [],
                    "recentBlockhash": "", "isVersioned": False,
                    "version": None, "transactionBytes": 0, "acceptedAt": 0,
                }],
                "count": 1, "total": 1,
            }, None
        return 404, {"error": {"code": "not_found", "message": "x"}}, None

    state["handler"] = handler
    client = _client(server)
    rec = client.get_payment("abc")
    assert rec.id == "abc"
    listed = client.list_payments(limit=5)
    assert listed.total == 1
    assert listed.items[0].id == "abc"


def test_error_envelope_parsed(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (
        409,
        {"error": {"code": "conflict", "message": "wallet already registered", "details": {"field": "wallet"}}},
        None,
    )
    client = _client(server)
    with pytest.raises(ZettaPayError) as exc_info:
        client.register_merchant(name="a", wallet_pubkey="p", usdc_ata="u")
    err = exc_info.value
    assert err.code == "conflict"
    assert err.status_code == 409
    assert err.details == {"field": "wallet"}
    assert is_code(err, "conflict")
    assert is_status(err, 409)


def test_error_without_envelope(fake_server):
    server, state = fake_server
    state["handler"] = lambda req: (404, "not found", None)
    client = _client(server)
    with pytest.raises(ZettaPayError) as exc_info:
        client.get_merchant(1)
    err = exc_info.value
    assert err.status_code == 404
    assert err.code == "http_error"


def test_retry_on_5xx_then_succeeds(fake_server):
    server, state = fake_server
    counter = {"n": 0}

    def handler(req: RecordedRequest):
        counter["n"] += 1
        if counter["n"] < 3:
            return 503, {"error": {"code": "upstream_error", "message": "try again"}}, None
        return 200, {"status": "ok", "merchants": 0, "payments": 0}, None

    state["handler"] = handler
    client = _client(
        server,
        retry=RetryPolicy(max_attempts=3, initial_backoff=0.001, max_backoff=0.005),
    )
    got = client.health()
    assert got.status == "ok"
    assert counter["n"] == 3


def test_retry_gives_up_after_max_attempts(fake_server):
    server, state = fake_server
    counter = {"n": 0}

    def handler(req: RecordedRequest):
        counter["n"] += 1
        return 503, {"error": {"code": "upstream_error", "message": "down"}}, None

    state["handler"] = handler
    client = _client(
        server,
        retry=RetryPolicy(max_attempts=3, initial_backoff=0.001, max_backoff=0.005),
    )
    with pytest.raises(ZettaPayError) as exc_info:
        client.health()
    assert counter["n"] == 3
    assert exc_info.value.code == "upstream_error"


def test_no_retry_on_post(fake_server):
    server, state = fake_server
    counter = {"n": 0}

    def handler(req: RecordedRequest):
        counter["n"] += 1
        return 503, {"error": {"code": "upstream_error", "message": "down"}}, None

    state["handler"] = handler
    client = _client(
        server,
        retry=RetryPolicy(max_attempts=3, initial_backoff=0.001, max_backoff=0.005),
    )
    with pytest.raises(ZettaPayError):
        client.register_merchant(name="x", wallet_pubkey="y", usdc_ata="z")
    assert counter["n"] == 1


def test_no_retry_on_4xx(fake_server):
    server, state = fake_server
    counter = {"n": 0}

    def handler(req: RecordedRequest):
        counter["n"] += 1
        return 404, {"error": {"code": "not_found", "message": "missing"}}, None

    state["handler"] = handler
    client = _client(
        server,
        retry=RetryPolicy(max_attempts=3, initial_backoff=0.001, max_backoff=0.005),
    )
    with pytest.raises(ZettaPayError) as exc_info:
        client.get_merchant(1)
    assert counter["n"] == 1
    assert is_code(exc_info.value, "not_found")


def test_retry_on_429(fake_server):
    server, state = fake_server
    counter = {"n": 0}

    def handler(req: RecordedRequest):
        counter["n"] += 1
        if counter["n"] == 1:
            return 429, {"error": {"code": "rate_limited", "message": "slow down"}}, None
        return 200, {"status": "ok", "merchants": 0, "payments": 0}, None

    state["handler"] = handler
    client = _client(
        server,
        retry=RetryPolicy(max_attempts=3, initial_backoff=0.001, max_backoff=0.005),
    )
    got = client.health()
    assert got.status == "ok"
    assert counter["n"] == 2


def test_auth_header_and_user_agent(fake_server):
    server, state = fake_server

    captured = {}

    def handler(req: RecordedRequest):
        captured["auth"] = req.headers.get("Authorization")
        captured["ua"] = req.headers.get("User-Agent")
        captured["custom"] = req.headers.get("X-Custom")
        return 200, {"status": "ok", "merchants": 0, "payments": 0}, None

    state["handler"] = handler
    client = ZettaPayClient(
        server.base_url,
        api_key="secret",
        headers={"X-Custom": "yes"},
    )
    client.health()
    assert captured["auth"] == "Bearer secret"
    assert captured["ua"].startswith("zettapay-python-sdk/")
    assert captured["custom"] == "yes"


def test_error_is_retryable_helper():
    network = ZettaPayError("net", "network_error", None)
    assert network.is_retryable()
    server_err = ZettaPayError("down", "upstream_error", 503)
    assert server_err.is_retryable()
    rate = ZettaPayError("slow", "rate_limited", 429)
    assert rate.is_retryable()
    not_found = ZettaPayError("missing", "not_found", 404)
    assert not not_found.is_retryable()
