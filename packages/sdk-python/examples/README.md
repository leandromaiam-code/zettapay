# Python SDK examples

Runnable examples that exercise the `zettapay` package end-to-end.

| Example | Highlights |
| --- | --- |
| [`quickstart.py`](./quickstart.py) | Sync client. Health probe → register → read → list → patch → pay (optional) → delete. |

## Run

From the SDK root (`packages/sdk-python`):

```bash
pip install -e .
python examples/quickstart.py
```

Point at a non-default deployment with env vars:

```bash
ZETTAPAY_BASE_URL=https://api.zettapay.dev \
ZETTAPAY_API_KEY=zp_live_... \
python examples/quickstart.py
```

The `pay()` step is skipped unless `ZETTAPAY_SIGNED_TX_BASE64` is set —
the SDK does not sign transactions. Build a signed Solana USDC transfer
with your wallet/keypair tooling (e.g. `@solana/web3.js`, `solders`) and
pass the base64-encoded blob via env var.

## Add an example

1. Drop a self-contained script into this directory.
2. Use only the public surface re-exported from `zettapay`.
3. Read configuration from env vars — never hard-code keys or wallet
   addresses beyond throwaway demo values.
4. Add a row to the table above and open a PR. See
   [`../CONTRIBUTING.md`](../CONTRIBUTING.md) for the full contributor
   guide.
