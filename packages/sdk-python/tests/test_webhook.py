from __future__ import annotations

import hashlib
import hmac
import json
from email.message import Message
from typing import Any, Dict, Optional

import pytest

from zettapay.webhook import (
    ATTEMPT_HEADER,
    EVENT_ID_HEADER,
    INVALID_PAYLOAD,
    INVALID_TIMESTAMP,
    MALFORMED_SIGNATURE,
    MISSING_EVENT_ID,
    MISSING_SIGNATURE,
    MISSING_TIMESTAMP,
    SIGNATURE_HEADER,
    SIGNATURE_MISMATCH,
    TIMESTAMP_HEADER,
    TIMESTAMP_OUT_OF_TOLERANCE,
    ParsedWebhook,
    ParseWebhookResult,
    parse_webhook,
)

SECRET = "whsec_test_python_sdk"
TS = 1_700_000_000_000
EVENT_ID = "evt_01HABCD"


def _sign(body: str, timestamp: int = TS, secret: str = SECRET) -> str:
    mac = hmac.new(secret.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256)
    return mac.hexdigest()


def _headers(
    *,
    body: str,
    event_id: str = EVENT_ID,
    timestamp: int = TS,
    attempt: Optional[int] = None,
    secret: str = SECRET,
) -> Dict[str, str]:
    sig = _sign(body, timestamp, secret)
    headers = {
        SIGNATURE_HEADER: f"sha256={sig}",
        TIMESTAMP_HEADER: str(timestamp),
        EVENT_ID_HEADER: event_id,
    }
    if attempt is not None:
        headers[ATTEMPT_HEADER] = str(attempt)
    return headers


def _body() -> str:
    return json.dumps({"type": "payment.succeeded", "data": {"id": "pay_123"}})


def test_verifies_signature_and_returns_dedup_key():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body, attempt=2),
        now_ms=lambda: TS,
    )
    assert result.valid is True
    assert result.reason is None
    assert isinstance(result.event, ParsedWebhook)
    assert result.event.event_id == EVENT_ID
    assert result.event.timestamp == TS
    assert result.event.attempt == 2
    assert result.event.raw_body == body
    assert result.event.payload == {"type": "payment.succeeded", "data": {"id": "pay_123"}}


def test_accepts_bytes_body_like_a_raw_wsgi_body():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body.encode("utf-8"),
        headers=_headers(body=body),
        now_ms=lambda: TS,
    )
    assert result.valid is True


def test_accepts_bytearray_and_memoryview_bodies():
    body = _body()
    headers = _headers(body=body)

    ba = bytearray(body, "utf-8")
    assert parse_webhook(secret=SECRET, body=ba, headers=headers, now_ms=lambda: TS).valid

    mv = memoryview(body.encode("utf-8"))
    assert parse_webhook(secret=SECRET, body=mv, headers=headers, now_ms=lambda: TS).valid


def test_reads_headers_case_insensitive_from_email_message():
    body = _body()
    msg = Message()
    for k, v in _headers(body=body).items():
        msg[k.lower()] = v  # lowercase, like ASGI/HTTP/1 normalization
    result = parse_webhook(secret=SECRET, body=body, headers=msg, now_ms=lambda: TS)
    assert result.valid is True


def test_rejects_missing_event_id_so_merchants_can_dedupe():
    body = _body()
    headers = _headers(body=body)
    del headers[EVENT_ID_HEADER]
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result == ParseWebhookResult(valid=False, reason=MISSING_EVENT_ID)


def test_rejects_missing_signature_header():
    body = _body()
    headers = _headers(body=body)
    del headers[SIGNATURE_HEADER]
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == MISSING_SIGNATURE


def test_rejects_missing_timestamp_header():
    body = _body()
    headers = _headers(body=body)
    del headers[TIMESTAMP_HEADER]
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == MISSING_TIMESTAMP


def test_rejects_non_numeric_timestamp():
    body = _body()
    headers = _headers(body=body)
    headers[TIMESTAMP_HEADER] = "not-a-number"
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == INVALID_TIMESTAMP


def test_rejects_stale_timestamp_outside_5min_window():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body),
        now_ms=lambda: TS + 6 * 60 * 1000,
    )
    assert result.valid is False
    assert result.reason == TIMESTAMP_OUT_OF_TOLERANCE


def test_accepts_drift_at_the_tolerance_boundary():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body),
        now_ms=lambda: TS + 300 * 1000,
    )
    assert result.valid is True


def test_honors_custom_tolerance():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body),
        tolerance_sec=10,
        now_ms=lambda: TS + 11 * 1000,
    )
    assert result.valid is False
    assert result.reason == TIMESTAMP_OUT_OF_TOLERANCE


def test_rejects_tampered_payload_via_signature_mismatch():
    body = _body()
    headers = _headers(body=body)
    result = parse_webhook(
        secret=SECRET,
        body=body + "tampered",
        headers=headers,
        now_ms=lambda: TS,
    )
    assert result.valid is False
    assert result.reason == SIGNATURE_MISMATCH


def test_rejects_signature_signed_with_a_different_secret():
    body = _body()
    headers = _headers(body=body, secret="whsec_wrong")
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == SIGNATURE_MISMATCH


def test_rejects_malformed_signature_with_non_hex_characters():
    body = _body()
    headers = _headers(body=body)
    headers[SIGNATURE_HEADER] = "sha256=not-hex!!!"
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == MALFORMED_SIGNATURE


def test_rejects_signature_with_odd_hex_length():
    body = _body()
    headers = _headers(body=body)
    headers[SIGNATURE_HEADER] = "sha256=abc"
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == MALFORMED_SIGNATURE


def test_accepts_bare_hex_signature_without_sha256_prefix():
    body = _body()
    headers = _headers(body=body)
    headers[SIGNATURE_HEADER] = _sign(body)
    result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    assert result.valid is True


def test_rejects_invalid_json_body():
    broken = "{not-json"
    headers = _headers(body=broken)
    result = parse_webhook(secret=SECRET, body=broken, headers=headers, now_ms=lambda: TS)
    assert result.valid is False
    assert result.reason == INVALID_PAYLOAD


def test_parse_payload_can_narrow_the_payload_type():
    body = _body()
    captured: Dict[str, Any] = {}

    def narrow(raw: Any) -> Dict[str, Any]:
        captured["raw"] = raw
        assert raw["type"] == "payment.succeeded"
        return {"id": raw["data"]["id"]}

    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body),
        now_ms=lambda: TS,
        parse_payload=narrow,
    )
    assert result.valid is True
    assert result.event.payload == {"id": "pay_123"}
    assert captured["raw"]["data"]["id"] == "pay_123"


def test_parse_payload_errors_surface_as_invalid_payload():
    body = _body()

    def reject(_: Any) -> Any:
        raise ValueError("schema mismatch")

    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body),
        now_ms=lambda: TS,
        parse_payload=reject,
    )
    assert result.valid is False
    assert result.reason == INVALID_PAYLOAD


def test_attempt_header_is_none_when_absent():
    body = _body()
    result = parse_webhook(
        secret=SECRET, body=body, headers=_headers(body=body), now_ms=lambda: TS
    )
    assert result.valid is True
    assert result.event.attempt is None


def test_attempt_header_parses_as_integer():
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body, attempt=5),
        now_ms=lambda: TS,
    )
    assert result.valid is True
    assert result.event.attempt == 5


def test_uses_timing_safe_compare_for_signature():
    # We can't observe wall-clock timing reliably, but we can assert the
    # helper delegates to hmac.compare_digest by patching it.
    body = _body()
    headers = _headers(body=body)
    calls: Dict[str, int] = {"n": 0}

    import zettapay.webhook as wh

    original = wh.hmac.compare_digest

    def spy(a: str, b: str) -> bool:
        calls["n"] += 1
        return original(a, b)

    wh.hmac.compare_digest = spy  # type: ignore[assignment]
    try:
        result = parse_webhook(secret=SECRET, body=body, headers=headers, now_ms=lambda: TS)
    finally:
        wh.hmac.compare_digest = original  # type: ignore[assignment]
    assert result.valid is True
    assert calls["n"] == 1


def test_rejects_str_body_that_differs_from_signed_bytes():
    # Subtle: signing over a JSON string with extra whitespace would change the
    # HMAC. This guards merchants who accidentally re-serialize before calling.
    body = _body()
    headers = _headers(body=body)
    reserialized = json.dumps(json.loads(body), indent=2)
    result = parse_webhook(
        secret=SECRET, body=reserialized, headers=headers, now_ms=lambda: TS
    )
    assert result.valid is False
    assert result.reason == SIGNATURE_MISMATCH


def test_default_clock_accepts_recent_timestamp():
    # Smoke-test the default ``now_ms`` path (no override) — sign with current
    # epoch ms so the helper's real clock falls inside tolerance.
    import time as real_time

    now = int(real_time.time() * 1000)
    body = _body()
    result = parse_webhook(
        secret=SECRET,
        body=body,
        headers=_headers(body=body, timestamp=now),
    )
    assert result.valid is True
