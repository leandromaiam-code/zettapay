"""End-to-end ZettaPay Python SDK quickstart.

Walks the full happy path against a live API:

    1. Health probe.
    2. Register a merchant.
    3. Read it back, list with pagination, patch it.
    4. Submit a base64-encoded x402 payment (requires a real signed tx).
    5. Clean up.

Run against a local API (no auth):

    python examples/quickstart.py

Run against a deployed environment:

    ZETTAPAY_BASE_URL=https://api.zettapay.dev \\
    ZETTAPAY_API_KEY=zp_live_... \\
    python examples/quickstart.py

The payment step is skipped unless ``ZETTAPAY_SIGNED_TX_BASE64`` is set —
the SDK does not sign transactions; produce a base64-encoded signed Solana
transfer with your wallet/keypair tooling and pass it via env var.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

from zettapay import (
    RetryPolicy,
    ZettaPayClient,
    ZettaPayError,
    is_code,
    is_status,
)


def main() -> int:
    base_url = os.environ.get("ZETTAPAY_BASE_URL", "http://localhost:3000")
    api_key: Optional[str] = os.environ.get("ZETTAPAY_API_KEY")
    signed_tx: Optional[str] = os.environ.get("ZETTAPAY_SIGNED_TX_BASE64")

    client = ZettaPayClient(
        base_url,
        api_key=api_key,
        timeout=10.0,
        retry=RetryPolicy.default(),
    )

    print(f"→ ZettaPay quickstart against {base_url}")

    health = client.health()
    print(f"  health: status={health.status} merchants={health.merchants} payments={health.payments}")

    merchant = client.register_merchant(
        name="Acme Coffee",
        wallet_pubkey="7Np41oeYqPefeNQEHSv1UDhYrehxin3NStpSyab9YVhT",
        usdc_ata="EhpbDdUDKv2Ah6yyhyqz7n9zUQqvmW1qzPKNaqgQ4kZK",
    )
    print(f"  registered merchant id={merchant.id} name={merchant.name!r}")

    fetched = client.get_merchant(merchant.id)
    assert fetched.id == merchant.id
    print(f"  fetched merchant id={fetched.id} createdAt={fetched.created_at}")

    listing = client.list_merchants(limit=5)
    print(f"  list_merchants: count={listing.count} returned={len(listing.items)}")

    patched = client.update_merchant(merchant.id, name="Acme Coffee — Downtown")
    print(f"  patched merchant name={patched.name!r}")

    if signed_tx:
        receipt = client.pay(signed_tx)
        print(
            f"  pay: accepted={receipt.accepted} payment_id={receipt.payment_id} "
            f"feePayer={receipt.fee_payer}"
        )
        record = client.get_payment(receipt.payment_id)
        print(f"  get_payment: id={record.id} signers={len(record.signers)}")
    else:
        print("  pay: skipped (set ZETTAPAY_SIGNED_TX_BASE64 to exercise /pay)")

    client.delete_merchant(merchant.id)
    print(f"  deleted merchant id={merchant.id}")

    try:
        client.get_merchant(merchant.id)
    except ZettaPayError as err:
        if is_code(err, "not_found") or is_status(err, 404):
            print(f"  confirmed deletion (404 not_found)")
        else:
            raise

    print("✓ done")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ZettaPayError as err:
        print(
            f"✗ ZettaPayError code={err.code!r} status={err.status_code} message={err.message!r}",
            file=sys.stderr,
        )
        sys.exit(1)
