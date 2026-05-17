from __future__ import annotations

import json

import pytest

from tests.conftest import FakeApiServer
from zettapay import (
    SUPPORTED_CHAINS,
    WebhookInvoicePayload,
    ZettaPayClient,
    ZettaPayError,
    is_supported_chain,
    normalize_webhook_chain,
)


def _invoice_body(chain: str) -> dict:
    return {
        "invoice_id": "inv_abc",
        "chain": chain,
        "receive_address": "bc1qexample" if chain == "btc" else "0xExample",
        "amount_usd": 29,
        "amount_native": "0.00045" if chain == "btc" else "29.00",
        "qr_uri": f"{chain}:address?amount=29",
        "expires_at": 1_700_000_000,
        "status": "pending",
        "verify_url": "https://explorer.example/tx/abc",
        "metadata": {"order_id": "xyz"},
    }


def test_supported_chains_enumerates_four():
    assert SUPPORTED_CHAINS == ("btc", "base", "polygon", "ethereum")


@pytest.mark.parametrize("chain", ["btc", "base", "polygon", "ethereum"])
def test_is_supported_chain_accepts(chain):
    assert is_supported_chain(chain)


@pytest.mark.parametrize("bad", ["solana", "BTC", "", None, 42])
def test_is_supported_chain_rejects(bad):
    assert not is_supported_chain(bad)


def test_normalize_webhook_chain_unknown_for_legacy():
    assert normalize_webhook_chain(None) == "unknown"
    assert normalize_webhook_chain("solana") == "unknown"
    assert normalize_webhook_chain("btc") == "btc"


def test_invoices_create_posts_chain_and_amount():
    captured: dict = {}

    def handler(req):
        captured["method"] = req.method
        captured["path"] = req.path
        captured["body"] = json.loads(req.body or b"{}")
        return 200, _invoice_body("base"), None

    server = FakeApiServer(handler=handler).start()
    try:
        client = ZettaPayClient(server.base_url)
        invoice = client.invoices.create(
            amount_usd=29,
            chain="base",
            metadata={"order_id": "xyz"},
        )
        assert captured["method"] == "POST"
        assert captured["path"] == "/api/invoices"
        assert captured["body"] == {
            "amount_usd": 29,
            "chain": "base",
            "metadata": {"order_id": "xyz"},
        }
        assert invoice.chain == "base"
        assert invoice.receive_address == "0xExample"
        assert invoice.amount_native == "29.00"
    finally:
        server.stop()


def test_invoices_create_omits_optional_fields():
    captured: dict = {}

    def handler(req):
        captured["body"] = json.loads(req.body or b"{}")
        return 200, _invoice_body("btc"), None

    server = FakeApiServer(handler=handler).start()
    try:
        client = ZettaPayClient(server.base_url)
        client.invoices.create(amount_usd=5, chain="btc")
        assert captured["body"] == {"amount_usd": 5, "chain": "btc"}
    finally:
        server.stop()


def test_invoices_create_rejects_unknown_chain_client_side():
    client = ZettaPayClient("http://127.0.0.1:1")
    with pytest.raises(ZettaPayError, match="chain must be one of"):
        client.invoices.create(amount_usd=10, chain="solana")


def test_invoices_create_rejects_non_positive_amount():
    client = ZettaPayClient("http://127.0.0.1:1")
    with pytest.raises(ZettaPayError):
        client.invoices.create(amount_usd=0, chain="base")
    with pytest.raises(ZettaPayError):
        client.invoices.create(amount_usd=-1, chain="base")


def test_webhook_payload_parses_chain():
    raw = {
        "invoice_id": "inv_001",
        "status": "confirmed",
        "chain": "base",
        "tx_hash": "0xabc",
        "amount_native": "29.00",
        "confirmations": 3,
        "receive_address": "0xMerchant",
        "merchant_id": "mer_42",
    }
    payload = WebhookInvoicePayload.from_api(raw)
    assert payload.chain == "base"
    assert payload.tx_hash == "0xabc"
    assert payload.confirmations == 3


def test_webhook_payload_legacy_missing_chain():
    raw = {
        "invoice_id": "inv_legacy",
        "status": "confirmed",
        "tx_hash": "0xabc",
        "amount_native": "29.00",
        "confirmations": 3,
        "receive_address": "0xMerchant",
        "merchant_id": "mer_42",
    }
    payload = WebhookInvoicePayload.from_api(raw)
    assert payload.chain == "unknown"
