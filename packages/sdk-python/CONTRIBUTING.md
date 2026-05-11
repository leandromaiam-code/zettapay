# Contributing to the ZettaPay Python SDK

Thanks for your interest in `zettapay` for Python. This SDK is **community-maintained** alongside the canonical TypeScript client; the surface is intentionally small and the bar for changes is "would the TS SDK do this?".

This document covers what we accept, the local setup, and the conventions every PR must follow.

## What we accept

| ✅ Welcome | ❌ Not in scope |
| --- | --- |
| New endpoints that already exist on the API. | Endpoints that don't exist server-side yet — file an issue first. |
| Async client parity for any new sync method. | Custom retry/backoff schemes beyond `RetryPolicy`. |
| New examples under [`examples/`](./examples). | Wallet/keypair management, transaction signing — out of scope. |
| Docstring fixes, type-hint improvements, mypy/pyright wins. | Reformatting unrelated files, drive-by linting. |
| Bug fixes with a regression test. | Adding runtime dependencies — see "Zero deps" below. |

If you're unsure, open an issue describing the change before writing code.

## Zero runtime dependencies

The SDK ships **standard library only**. `urllib`, `http.server`, `json`,
`base64`, `dataclasses`, `asyncio` — that's it. This keeps the install
fast, side-effect free, and safe in locked-down environments (Lambda,
containers, agent sandboxes).

PRs that add a runtime dependency will be closed unless they come with a
clear, narrow justification and a maintainer +1 in the issue first. Test
dependencies (under `[project.optional-dependencies].test`) are fine.

## Local setup

```bash
git clone https://github.com/leandromaiam-code/zettapay
cd zettapay/packages/sdk-python

python -m venv .venv
source .venv/bin/activate

pip install -e ".[test]"
pytest
```

Supported Python versions: **3.9 → 3.13**. The CI matrix runs each.

## Run the examples

```bash
python examples/quickstart.py
```

See [`examples/README.md`](./examples/README.md) for env vars and how to
exercise the `/pay` endpoint with a real signed Solana transaction.

## Conventions

- **Public surface.** Anything users import lives in
  [`zettapay/__init__.py`](./zettapay/__init__.py). Adding a public symbol
  means: implementation file → re-export in `__init__.py` → entry in
  `__all__` → docstring → README/API surface table.
- **Naming.** snake_case for Python identifiers, even when the API uses
  camelCase (`walletPubkey` ↔ `wallet_pubkey`). The `from_api` classmethods
  on dataclasses do the translation.
- **Errors.** Every method raises `ZettaPayError` on non-2xx or transport
  failure. Don't swallow exceptions; don't invent new exception classes.
- **Async parity.** Anything added to `ZettaPayClient` must also be added
  to `AsyncZettaPayClient` with the same signature.
- **Type hints.** Required everywhere. The package ships `py.typed` and
  must remain compatible with mypy `--strict` and pyright `strict`.
- **Tests.** Required for behavioral changes. Tests spin up a real HTTP
  server via `http.server` (no mocking, no recording fixtures). Look at
  [`tests/conftest.py`](./tests/conftest.py) for the helper.
- **Idempotency.** `GET`, `DELETE`, and `/healthz` are retried.
  `POST /pay`, `POST /merchants`, `PATCH /merchants/:id` execute exactly
  once. Don't change this without a server-side change first.
- **No breaking changes** without a major version bump and a deprecation
  cycle. We ship to PyPI; people pin.

## Commits & PRs

- Conventional commit subjects: `feat(sdk-python): …`, `fix(sdk-python): …`,
  `docs(sdk-python): …`, `test(sdk-python): …`.
- Keep PRs focused — one logical change per PR.
- Reference the issue you're solving in the PR description.
- CI must be green before review (build, tests, type-check).

## Reporting issues

- **Bugs:** [GitHub issues](https://github.com/leandromaiam-code/zettapay/issues)
  with a minimal repro, Python version, and SDK version.
- **Security:** `security@zettapay.io` — never open a public issue for
  vulnerabilities. PGP available on request.
- **Feedback / questions:** the [`#sdk-python`](https://discord.gg/zettapay)
  channel on Discord.

## License

By contributing you agree your work is licensed under the [MIT
license](../../LICENSE) of this repository.
