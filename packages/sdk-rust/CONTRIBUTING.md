# Contributing to the ZettaPay Rust SDK

Thanks for your interest in `zettapay` for Rust. This SDK is **community-maintained** alongside the canonical TypeScript client; the surface is intentionally small and the bar for changes is "would the TS SDK do this?".

This document covers what we accept, the local setup, and the conventions every PR must follow.

## What we accept

| ✅ Welcome | ❌ Not in scope |
| --- | --- |
| New endpoints that already exist on the API. | Endpoints that don't exist server-side yet — file an issue first. |
| New examples under [`examples/`](./examples). | Custom retry/backoff schemes beyond `RetryPolicy`. |
| Doc-comment polish, `cargo doc` wins, more `#[doc(hidden)]` precision. | Wallet/keypair management, transaction signing — out of scope. |
| Bug fixes with an integration test. | Reformatting unrelated files, drive-by clippy lints on stable code. |
| Smaller transitive dep trees, MSRV bumps with justification. | Adding heavyweight deps (anyhow, thiserror, async-trait) — see "Dep policy". |

If you're unsure, open an issue describing the change before writing code.

## Dep policy

The SDK is intentionally lean. Current production deps:

- `tokio` (default features off)
- `reqwest` (rustls-tls, no native-tls)
- `serde` / `serde_json`
- `base64`, `url`, `rand`

PRs adding a runtime dep need a clear, narrow justification and a
maintainer +1 in the issue first. Test deps under `[dev-dependencies]`
are easier — just keep them small.

## MSRV

Minimum Supported Rust Version: **1.75**. Bumps require a separate PR
with rationale and a CI matrix update.

## Local setup

```bash
git clone https://github.com/leandromaiam-code/zettapay
cd zettapay/packages/sdk-rust

cargo build
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

The integration tests use [`mockito`](https://docs.rs/mockito) — no real
network, no recording fixtures.

## Run the example

```bash
cargo run --example quickstart
```

See the comment header in [`examples/quickstart.rs`](./examples/quickstart.rs)
for env vars and how to exercise the `/pay` endpoint with a real signed
Solana transaction.

## Conventions

- **Public surface.** Anything users import lives in
  [`src/lib.rs`](./src/lib.rs). Adding a public symbol means: implementation
  module → `pub use` in `lib.rs` → doc comment with a `# Example` →
  README/API surface table.
- **Naming.** snake_case Rust identifiers, camelCase wire names via
  `#[serde(rename = "…")]`. Look at [`src/types.rs`](./src/types.rs) for
  the pattern.
- **Errors.** Every method returns `Result<T, zettapay::Error>`. Don't
  introduce a second error type. Map foreign errors via `From` impls in
  [`src/error.rs`](./src/error.rs).
- **Async.** Everything is `async fn`. We don't ship a sync surface — if
  you need one, wrap with `tokio::runtime::Handle::block_on` in your app.
- **Doc comments.** Required on every public item, with a `# Example`
  block (`no_run` is fine for things that hit the network). `cargo doc`
  must build clean.
- **Tests.** Required for behavioral changes. Use `mockito` for HTTP
  shape; reach for assertions on request bodies and headers, not just
  status codes.
- **Idempotency.** `GET`, `DELETE`, and `/healthz` are retried.
  `POST /pay`, `POST /merchants`, `PATCH /merchants/:id` execute exactly
  once. Don't change this without a server-side change first.
- **No breaking changes** to the public API without a major version bump
  and a deprecation cycle. We publish to crates.io; people pin.

## Commits & PRs

- Conventional commit subjects: `feat(sdk-rust): …`, `fix(sdk-rust): …`,
  `docs(sdk-rust): …`, `test(sdk-rust): …`.
- Keep PRs focused — one logical change per PR.
- Reference the issue you're solving in the PR description.
- CI must be green before review (`cargo build`, `cargo test`,
  `cargo clippy -D warnings`, `cargo fmt --check`).

## Reporting issues

- **Bugs:** [GitHub issues](https://github.com/leandromaiam-code/zettapay/issues)
  with a minimal repro, `rustc --version`, and SDK version.
- **Security:** `security@zettapay.io` — never open a public issue for
  vulnerabilities. PGP available on request.
- **Feedback / questions:** the [`#sdk-rust`](https://discord.gg/zettapay)
  channel on Discord.

## License

By contributing you agree your work is licensed under the [MIT
license](../../LICENSE) of this repository.
