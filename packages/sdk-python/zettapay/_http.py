from __future__ import annotations

import json
import random
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Mapping, Optional, Tuple

from .errors import ZettaPayError
from .types import RetryPolicy

USER_AGENT = "zettapay-python-sdk/1.0"


def join_url(base: str, path: str, query: Optional[Mapping[str, Any]] = None) -> str:
    base = base.rstrip("/")
    if not path.startswith("/"):
        path = "/" + path
    url = base + path
    if query:
        encoded = urllib.parse.urlencode(
            {k: v for k, v in query.items() if v is not None},
            doseq=True,
        )
        if encoded:
            url += "?" + encoded
    return url


def _is_retryable_status(status: Optional[int]) -> bool:
    if status is None:
        return True
    if status == 429:
        return True
    return 500 <= status <= 599


def _parse_envelope(body: bytes) -> Optional[Tuple[str, str, Any]]:
    try:
        decoded = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict):
        return None
    err = decoded.get("error")
    if not isinstance(err, dict):
        return None
    code = err.get("code")
    message = err.get("message")
    if not isinstance(code, str) or not isinstance(message, str):
        return None
    return code, message, err.get("details")


def _truncated(body: bytes, limit: int = 200) -> str:
    text = body.decode("utf-8", errors="replace").strip()
    if len(text) > limit:
        return text[:limit] + "…"
    return text


def _backoff_delay(policy: RetryPolicy, attempt: int, rng: random.Random) -> float:
    base = policy.initial_backoff if policy.initial_backoff > 0 else 0.1
    cap = policy.max_backoff if policy.max_backoff > 0 else 2.0
    exp = base * (2 ** attempt)
    if exp > cap:
        exp = cap
    if exp <= 0:
        return 0.0
    return rng.uniform(0.0, exp)


def request(
    *,
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: Optional[bytes],
    timeout: float,
    retry: RetryPolicy,
    retryable: bool,
    rng: Optional[random.Random] = None,
    sleep: Any = time.sleep,
) -> Tuple[int, bytes]:
    """Execute an HTTP request with optional retry on transport / 429 / 5xx.

    Returns ``(status, body)`` on success. Raises ``ZettaPayError`` on transport
    failure, non-2xx responses (after retries are exhausted), or decode errors.
    """
    rng = rng or random.Random()
    attempts = max(1, retry.max_attempts) if retryable else 1
    last_err: Optional[ZettaPayError] = None

    for attempt in range(attempts):
        if attempt > 0:
            sleep(_backoff_delay(retry, attempt - 1, rng))
        status, payload, err = _attempt(method, url, headers, body, timeout)
        if err is None:
            assert status is not None and payload is not None
            if 200 <= status < 300:
                return status, payload
            last_err = _error_from_response(status, payload)
            if not retryable or not _is_retryable_status(status):
                raise last_err
            continue
        last_err = err
        if not retryable:
            raise err
        continue

    assert last_err is not None
    raise last_err


def _attempt(
    method: str,
    url: str,
    headers: Mapping[str, str],
    body: Optional[bytes],
    timeout: float,
) -> Tuple[Optional[int], Optional[bytes], Optional[ZettaPayError]]:
    req = urllib.request.Request(url=url, method=method.upper(), data=body)
    for k, v in headers.items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, payload, None
    except urllib.error.HTTPError as e:
        try:
            payload = e.read()
        except Exception:
            payload = b""
        return e.code, payload, None
    except urllib.error.URLError as e:
        reason = e.reason
        if isinstance(reason, socket.timeout):
            return None, None, ZettaPayError(
                "request timed out", "timeout", None, None, e
            )
        message = str(reason) if reason else "network error"
        return None, None, ZettaPayError(message, "network_error", None, None, e)
    except socket.timeout as e:
        return None, None, ZettaPayError("request timed out", "timeout", None, None, e)
    except OSError as e:
        return None, None, ZettaPayError(str(e), "network_error", None, None, e)


def _error_from_response(status: int, body: bytes) -> ZettaPayError:
    parsed = _parse_envelope(body)
    if parsed is not None:
        code, message, details = parsed
        return ZettaPayError(message, code, status, details)
    return ZettaPayError(
        _truncated(body) or f"request failed with status {status}",
        "http_error",
        status,
    )


def decode_json(payload: bytes) -> Dict[str, Any]:
    if not payload:
        return {}
    try:
        decoded = json.loads(payload.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ZettaPayError(str(exc), "decode_error", None, None, exc) from exc
    if not isinstance(decoded, dict):
        raise ZettaPayError(
            "expected JSON object response", "decode_error", None, decoded
        )
    return decoded
