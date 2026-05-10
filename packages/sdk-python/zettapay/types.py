from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, List, Optional


@dataclass(frozen=True)
class Merchant:
    id: int
    name: str
    wallet_pubkey: str
    usdc_ata: str
    created_at: int

    @classmethod
    def from_api(cls, data: dict) -> "Merchant":
        return cls(
            id=int(data["id"]),
            name=str(data["name"]),
            wallet_pubkey=str(data.get("walletPubkey", data.get("wallet_pubkey", ""))),
            usdc_ata=str(data.get("usdcAta", data.get("usdc_ata", ""))),
            created_at=int(data.get("createdAt", data.get("created_at", 0))),
        )


@dataclass(frozen=True)
class ListMerchantsResponse:
    items: List[Merchant]
    count: int

    @classmethod
    def from_api(cls, data: dict) -> "ListMerchantsResponse":
        items = [Merchant.from_api(m) for m in data.get("items", [])]
        return cls(items=items, count=int(data.get("count", len(items))))


@dataclass(frozen=True)
class PaymentRecord:
    id: str
    fee_payer: str
    signers: List[str]
    signatures: List[str]
    recent_blockhash: str
    is_versioned: bool
    version: Optional[int]
    transaction_bytes: int
    accepted_at: int

    @classmethod
    def from_api(cls, data: dict) -> "PaymentRecord":
        return cls(
            id=str(data["id"]),
            fee_payer=str(data.get("feePayer", "")),
            signers=list(data.get("signers", [])),
            signatures=list(data.get("signatures", [])),
            recent_blockhash=str(data.get("recentBlockhash", "")),
            is_versioned=bool(data.get("isVersioned", False)),
            version=data.get("version"),
            transaction_bytes=int(data.get("transactionBytes", 0)),
            accepted_at=int(data.get("acceptedAt", 0)),
        )


@dataclass(frozen=True)
class PayResponse:
    accepted: bool
    payment_id: str
    fee_payer: str
    signers: List[str]
    signature_count: int
    recent_blockhash: str
    is_versioned: bool
    version: Optional[int]
    transaction_bytes: int

    @classmethod
    def from_api(cls, data: dict) -> "PayResponse":
        return cls(
            accepted=bool(data.get("accepted", False)),
            payment_id=str(data.get("paymentId", "")),
            fee_payer=str(data.get("feePayer", "")),
            signers=list(data.get("signers", [])),
            signature_count=int(data.get("signatureCount", 0)),
            recent_blockhash=str(data.get("recentBlockhash", "")),
            is_versioned=bool(data.get("isVersioned", False)),
            version=data.get("version"),
            transaction_bytes=int(data.get("transactionBytes", 0)),
        )


@dataclass(frozen=True)
class ListPaymentsResponse:
    items: List[PaymentRecord]
    count: int
    total: int

    @classmethod
    def from_api(cls, data: dict) -> "ListPaymentsResponse":
        items = [PaymentRecord.from_api(p) for p in data.get("items", [])]
        return cls(
            items=items,
            count=int(data.get("count", len(items))),
            total=int(data.get("total", len(items))),
        )


@dataclass(frozen=True)
class HealthStatus:
    status: str
    merchants: int
    payments: int

    @classmethod
    def from_api(cls, data: dict) -> "HealthStatus":
        return cls(
            status=str(data.get("status", "")),
            merchants=int(data.get("merchants", 0)),
            payments=int(data.get("payments", 0)),
        )


@dataclass
class RetryPolicy:
    max_attempts: int = 1
    initial_backoff: float = 0.1
    max_backoff: float = 2.0

    @classmethod
    def default(cls) -> "RetryPolicy":
        return cls(max_attempts=3, initial_backoff=0.1, max_backoff=2.0)

    @classmethod
    def disabled(cls) -> "RetryPolicy":
        return cls(max_attempts=1)


@dataclass(frozen=True)
class _ApiErrorBody:
    code: str
    message: str
    details: Any = field(default=None)
