from __future__ import annotations

from typing import Any, Optional


class ZettaPayError(Exception):
    """Typed error returned by every client method on a non-2xx response or
    transport failure. Mirrors the JSON envelope emitted by the API:
    ``{"error": {"code", "message", "details"}}``.

    Callers can inspect ``code`` / ``status_code`` for control-flow.
    """

    def __init__(
        self,
        message: str,
        code: str,
        status_code: Optional[int] = None,
        details: Any = None,
        cause: Optional[BaseException] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.code = code
        self.status_code = status_code
        self.details = details
        self.__cause__ = cause

    def __str__(self) -> str:
        if self.status_code is not None:
            return f"zettapay: {self.message} (code={self.code}, status={self.status_code})"
        return f"zettapay: {self.message} (code={self.code})"

    def __repr__(self) -> str:
        return (
            f"ZettaPayError(message={self.message!r}, code={self.code!r}, "
            f"status_code={self.status_code!r})"
        )

    def is_retryable(self) -> bool:
        """Network failures (no status), 429, and 5xx are retryable."""
        if self.status_code is None:
            return True
        if self.status_code == 429:
            return True
        return 500 <= self.status_code <= 599


def is_code(err: BaseException, code: str) -> bool:
    """Return True iff ``err`` is a ``ZettaPayError`` with the given code."""
    return isinstance(err, ZettaPayError) and err.code == code


def is_status(err: BaseException, status: int) -> bool:
    """Return True iff ``err`` is a ``ZettaPayError`` with the given HTTP status."""
    return isinstance(err, ZettaPayError) and err.status_code == status
