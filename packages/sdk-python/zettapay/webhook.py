"""Webhook signature verification for ZettaPay merchants.

Mirrors the TypeScript SDK helper at ``packages/sdk/src/webhook.ts``: HMAC-SHA256
over ``"{timestamp}.{raw_body}"`` with a timing-safe compare, a 300s drift
window on ``X-ZettaPay-Timestamp``, and the stable ``X-ZettaPay-Event-Id`` so a
merchant can dedupe retries before doing work.

Pass the *raw* request body — re-encoding the JSON changes byte order and
invalidates the signature.

Example::

    from zettapay.webhook import parse_webhook

    result = parse_webhook(
        secret=os.environ["ZETTAPAY_WEBHOOK_SECRET"],
        body=request.get_data(),     # bytes, not request.json
        headers=request.headers,
    )
    if not result.valid:
        return ("", 400)
    if seen_before(result.event.event_id):
        return ("", 200)
    process(result.event.payload)
"""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Optional, Union

SIGNATURE_HEADER = "X-ZettaPay-Signature"
TIMESTAMP_HEADER = "X-ZettaPay-Timestamp"
EVENT_ID_HEADER = "X-ZettaPay-Event-Id"
ATTEMPT_HEADER = "X-ZettaPay-Attempt"

_SIGNATURE_PREFIX = "sha256="
_HEX_RE = re.compile(r"^[0-9a-f]+$", re.IGNORECASE)
_DEFAULT_TOLERANCE_SEC = 300

# Discrete failure reasons — match on these strings if you need to branch
# (e.g. log signature_mismatch differently from timestamp_out_of_tolerance).
MISSING_EVENT_ID = "missing_event_id"
MISSING_SIGNATURE = "missing_signature"
MALFORMED_SIGNATURE = "malformed_signature"
MISSING_TIMESTAMP = "missing_timestamp"
INVALID_TIMESTAMP = "invalid_timestamp"
TIMESTAMP_OUT_OF_TOLERANCE = "timestamp_out_of_tolerance"
SIGNATURE_MISMATCH = "signature_mismatch"
INVALID_PAYLOAD = "invalid_payload"

WEBHOOK_FAILURE_REASONS = frozenset(
    {
        MISSING_EVENT_ID,
        MISSING_SIGNATURE,
        MALFORMED_SIGNATURE,
        MISSING_TIMESTAMP,
        INVALID_TIMESTAMP,
        TIMESTAMP_OUT_OF_TOLERANCE,
        SIGNATURE_MISMATCH,
        INVALID_PAYLOAD,
    }
)

Body = Union[bytes, bytearray, memoryview, str]


@dataclass(frozen=True)
class ParsedWebhook:
    """A verified webhook delivery ready for the merchant to process."""

    # Stable across retries — use this as the idempotency dedup key.
    event_id: str
    # Epoch milliseconds emitted by the dispatcher (``X-ZettaPay-Timestamp``).
    timestamp: int
    # 1-indexed attempt number from ``X-ZettaPay-Attempt`` if present.
    attempt: Optional[int]
    # JSON-decoded body, optionally narrowed by ``parse_payload``.
    payload: Any
    # Verbatim raw body as a UTF-8 string — useful for re-signing in tests.
    raw_body: str


@dataclass(frozen=True)
class ParseWebhookResult:
    """Discriminated result of :func:`parse_webhook`.

    When ``valid`` is ``True``, ``event`` is populated. When ``False``,
    ``reason`` carries one of the ``*_REASON`` constants exposed by this module.
    """

    valid: bool
    event: Optional[ParsedWebhook] = None
    reason: Optional[str] = None


def parse_webhook(
    *,
    secret: str,
    body: Body,
    headers: Any,
    tolerance_sec: int = _DEFAULT_TOLERANCE_SEC,
    now_ms: Optional[Callable[[], int]] = None,
    parse_payload: Optional[Callable[[Any], Any]] = None,
) -> ParseWebhookResult:
    """Verify a ZettaPay webhook and return the parsed event.

    Args:
        secret: Merchant webhook secret (matches the value on the merchant
            record). Treat as a credential.
        body: Raw request body — ``bytes``, ``bytearray``, ``memoryview`` or
            pre-decoded UTF-8 ``str``. Re-encoding JSON breaks the HMAC.
        headers: Inbound headers. Accepts any object with ``.get(name)`` or
            ``.items()`` — works with ``dict``, ``http.client.HTTPMessage``,
            ``werkzeug``/``flask`` headers, ``starlette``/``fastapi`` headers
            and ``requests.structures.CaseInsensitiveDict``.
        tolerance_sec: Reject events whose timestamp drifts more than this
            many seconds from ``now``. Defaults to 300s.
        now_ms: Override the clock for tests; should return epoch milliseconds.
        parse_payload: Optional validator/narrower applied to the decoded JSON
            body. Raise to mark the payload invalid.
    """
    event_id = _read_header(headers, EVENT_ID_HEADER)
    if not event_id:
        return ParseWebhookResult(valid=False, reason=MISSING_EVENT_ID)

    signature = _read_header(headers, SIGNATURE_HEADER)
    if not signature:
        return ParseWebhookResult(valid=False, reason=MISSING_SIGNATURE)

    timestamp_raw = _read_header(headers, TIMESTAMP_HEADER)
    if not timestamp_raw:
        return ParseWebhookResult(valid=False, reason=MISSING_TIMESTAMP)
    try:
        timestamp = int(timestamp_raw)
    except (TypeError, ValueError):
        return ParseWebhookResult(valid=False, reason=INVALID_TIMESTAMP)

    now = now_ms() if now_ms is not None else int(time.time() * 1000)
    if abs(now - timestamp) > tolerance_sec * 1000:
        return ParseWebhookResult(valid=False, reason=TIMESTAMP_OUT_OF_TOLERANCE)

    provided = _parse_signature(signature)
    if provided is None:
        return ParseWebhookResult(valid=False, reason=MALFORMED_SIGNATURE)

    raw_body = _body_to_string(body)
    signed_input = f"{timestamp_raw}.{raw_body}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), signed_input, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, provided):
        return ParseWebhookResult(valid=False, reason=SIGNATURE_MISMATCH)

    try:
        decoded = None if len(raw_body) == 0 else json.loads(raw_body)
    except ValueError:
        return ParseWebhookResult(valid=False, reason=INVALID_PAYLOAD)

    try:
        payload = parse_payload(decoded) if parse_payload is not None else decoded
    except Exception:
        return ParseWebhookResult(valid=False, reason=INVALID_PAYLOAD)

    attempt_raw = _read_header(headers, ATTEMPT_HEADER)
    attempt: Optional[int]
    if attempt_raw is None:
        attempt = None
    else:
        try:
            attempt = int(attempt_raw)
        except (TypeError, ValueError):
            attempt = None

    return ParseWebhookResult(
        valid=True,
        event=ParsedWebhook(
            event_id=event_id,
            timestamp=timestamp,
            attempt=attempt,
            payload=payload,
            raw_body=raw_body,
        ),
    )


def _read_header(headers: Any, name: str) -> Optional[str]:
    lower = name.lower()

    get = getattr(headers, "get", None)
    if callable(get):
        for variant in (name, lower):
            try:
                value = get(variant)
            except TypeError:
                value = None
            value = _normalize_header_value(value)
            if value:
                return value

    items = getattr(headers, "items", None)
    if callable(items):
        try:
            iterable = items()
        except TypeError:
            iterable = ()
        for key, raw in iterable:
            if isinstance(key, bytes):
                key = key.decode("latin-1", errors="replace")
            if isinstance(key, str) and key.lower() == lower:
                value = _normalize_header_value(raw)
                if value:
                    return value
    return None


def _normalize_header_value(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, (list, tuple)):
        value = value[0] if value else None
        if value is None:
            return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="replace")
    if isinstance(value, str):
        return value if value else None
    return str(value)


def _parse_signature(raw: str) -> Optional[str]:
    trimmed = raw.strip()
    value = (
        trimmed[len(_SIGNATURE_PREFIX) :]
        if trimmed.startswith(_SIGNATURE_PREFIX)
        else trimmed
    )
    if not value or len(value) % 2 != 0:
        return None
    if not _HEX_RE.match(value):
        return None
    return value.lower()


def _body_to_string(body: Body) -> str:
    if isinstance(body, str):
        return body
    if isinstance(body, (bytes, bytearray)):
        return bytes(body).decode("utf-8")
    if isinstance(body, memoryview):
        return body.tobytes().decode("utf-8")
    raise TypeError(
        f"body must be bytes, bytearray, memoryview or str — got {type(body).__name__}"
    )


__all__ = [
    "ATTEMPT_HEADER",
    "EVENT_ID_HEADER",
    "INVALID_PAYLOAD",
    "INVALID_TIMESTAMP",
    "MALFORMED_SIGNATURE",
    "MISSING_EVENT_ID",
    "MISSING_SIGNATURE",
    "MISSING_TIMESTAMP",
    "ParsedWebhook",
    "ParseWebhookResult",
    "SIGNATURE_HEADER",
    "SIGNATURE_MISMATCH",
    "TIMESTAMP_HEADER",
    "TIMESTAMP_OUT_OF_TOLERANCE",
    "WEBHOOK_FAILURE_REASONS",
    "parse_webhook",
]
