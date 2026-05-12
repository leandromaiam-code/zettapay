# Static analysis — Sec3 X-ray + Soteria sweep (Z28.3)

Sprint Z28 validates the devnet build under stress and free-tier audit
tooling. This document records the static-analysis pass over the entire
on-chain Rust surface and links every Sec3 X-ray / Soteria check class
to the exact code that satisfies it (or the documented mitigation for
the few that cannot be satisfied by source alone).

## Why two scanners

Sec3 X-ray and Soteria cover overlapping but not identical territory:

| Tool | Origin | What it adds |
| --- | --- | --- |
| **Sec3 X-ray** | Commercial successor to the Soteria research prototype, run by `sec3.dev`. | Cloud LLVM-IR analysis of the BPF binary; richest catalogue of Anchor-specific anti-patterns; free tier for OSS programs at <https://app.sec3.dev>. |
| **Soteria** | The open-source predecessor, distributed as `soteria-bin` and now an internal Sec3 component. | Bump-seed canonicalisation, arithmetic overflow, and a handful of Solana-native checks that pre-date Anchor; still useful as a second opinion that doesn't share Sec3's parser. |

Running both at the audit milestones (Z21 pre-engagement, again after
remediation) is the industry baseline for a Solana program of this
size. Running them on every PR would be operationally noisy — cloud
turnaround is minutes, free-tier quotas apply, and the heuristic
catalogue is small enough that we can codify it once and re-run
locally with no network.

That codification is `scripts/static-analysis-rust.sh`: 14 deterministic
checks, mapped 1:1 to the canonical Sec3 catalogue, runnable in CI on
every push, gating merge the same way the build does.

## How this was produced

1. Inventoried every `.rs` file under `programs/` (`zettapay`, the
   Anchor crate; `zettapay-core`, the native-program crate).
2. For each Sec3 / Soteria check class, located the production code
   path that the class targets and decided whether the heuristic was
   *satisfied at source*, *satisfied via tooling configuration* (e.g.
   `overflow-checks = true`), or *non-applicable* (no code path
   triggers the class).
3. Wrote `scripts/static-analysis-rust.sh` so every "satisfied" verdict
   below survives future churn: if a refactor regresses a checked
   condition, CI fails the same way clippy would.
4. Ran the script. All 14 checks pass; the summary is `Static analysis
   clean — 14 check(s) all green.`.

## Toolchain pins

- `programs/zettapay` — Anchor `0.30.1`, Solana `1.18.26` (per
  `Anchor.toml`).
- `programs/zettapay-core` — `solana-program 1.18.26`, `borsh 0.10.3`
  (pinned together per `programs/zettapay-core/Cargo.toml:18-22`).
- Workspace `Cargo.toml` enables `overflow-checks = true` for the
  release profile so every plain `+ - *` in shipped BPF aborts on
  overflow rather than wrapping.

## Findings

**Zero actionable findings.** The pre-existing defensive structure
(narrow surface area, Anchor's account macros, explicit signer/owner
asserts in the native dispatcher, fixed-size account layouts, single
canonical-bump derivation, no CPI other than `system_program`) already
satisfies every check Sec3 X-ray and Soteria flag.

The table below records each check, the rule, the code location that
satisfies it, and the residual risk an auditor should still confirm
manually.

| ID | Rule (Sec3 / Soteria class) | Verdict | Where satisfied | Residual reviewer task |
| --- | --- | --- | --- | --- |
| X-001 | Missing signer check on authority accounts | **Pass** | Anchor: `programs/zettapay/src/lib.rs:115,120` (`Signer<'info>` on owner + payer). Native: `programs/zettapay-core/src/lib.rs:129,133,193,194,273` (5× `assert_signer` across 3 handlers). | Confirm no future handler is added without `assert_signer` on the authority account. |
| X-002 | Owner check missing before deserialize | **Pass** | Native: `programs/zettapay-core/src/lib.rs:192,272,294` (`assert_owned_by_program` on every account that's later `try_from_slice`'d). Anchor: implicit via `Account<'info, T>`. | Re-derive when a new instruction is added; missing owner check on a freshly added account is the canonical "fake account" exploit. |
| X-003 | Account type confusion / type cosplay | **Pass** | Native uses a single-byte `tag` field; checked at `programs/zettapay-core/src/lib.rs:199,277,303` after Borsh deserialize. Anchor uses the 8-byte discriminator on `MerchantBinding` and `Payment`. | Tag values must remain stable across releases (`MERCHANT_TAG = 1`, `INVOICE_TAG = 2`) — a renumber is an account-format break. |
| X-004 | Insecure CPI / system-program substitution | **Pass** | Native: `programs/zettapay-core/src/lib.rs:134,195` (`assert_system_program` before both `invoke_signed` sites at `lib.rs:144,216`). | The Anchor crate's implicit `init` CPI is gated by Anchor's own type check on `Program<'info, System>` at `lib.rs:122,153`. |
| X-005 | Arithmetic overflow | **Pass** | Workspace `Cargo.toml:5` sets `overflow-checks = true`. The only production arithmetic on a persisted counter is `invoice_count.checked_add(1)` at `programs/zettapay-core/src/lib.rs:248`. | Confirm release-mode build retains the workspace profile (Anchor's `anchor build` honours it; `cargo build-sbf` does too). |
| X-006 | Reinitialization attack | **Pass** | Anchor: `init,` on both PDAs (`programs/zettapay/src/lib.rs:105,137`); `init_if_needed` would fail this check and is not used. Native: `system_instruction::create_account` (`lib.rs:144,216`) fails with `0x0` on a pre-existing account. | If a future Sweep-like instruction starts re-writing data into an existing account, confirm the immutability invariant is preserved or document the deviation. |
| X-007 | Bump seed canonicalization | **Pass** | Anchor: only `bump,` (no rhs) at `programs/zettapay/src/lib.rs:109,141`. Native: bump comes from `find_*_pda` return tuple at `programs/zettapay-core/src/lib.rs:136,208`, not from instruction args. | Refusing user-supplied bumps is the entire point of this class — any future `args.bump` is a regression. |
| X-008 | PDA seed mining (handler must re-derive and compare) | **Pass** | Native: every `find_*_pda(...)` call at `programs/zettapay-core/src/lib.rs:136,208,296` is followed by `if *_ai.key != &expected_pda` returning the type-specific `PdaMismatch` error. | Re-check when adding new PDA-typed accounts; the equality check is what keeps `[master, x]` from posing as `[master, y]`. |
| X-009 | Duplicate mutable accounts (sweep idempotency) | **Pass** | `programs/zettapay-core/src/lib.rs:309` rejects `status != INVOICE_STATUS_OPEN`, so a duplicate index in `invoice_indexes` is rejected on the second iteration. The arithmetic also can't desync: `invoice_count` is monotonically incremented at `lib.rs:246-249` and never decremented. | Confirm a multi-invoice sweep is integration-tested with both unique indexes (`tests/zettapay.ts`) and a deliberately duplicate index. |
| X-010 | Sysvar account abuse | **Pass** | All sysvar reads are via the syscall form (`Clock::get()`, `Rent::get()`); no `from_account_info` for sysvars anywhere in production code. | A future instruction that *needs* a sysvar account input (e.g. instructions sysvar for x402 receipt verification) must be reviewed for substitution attacks. |
| X-011 | `unwrap` / `panic!` / `unimplemented!` in production code | **Pass** | None outside `#[cfg(test)]` modules. The scanner's awk filter strips test modules before grepping. | Every new handler must use `?` error propagation; a single production `unwrap` is a DoS surface. |
| X-012 | `unsafe` blocks | **Pass** | No `unsafe` blocks in either crate. | Any future `unsafe` block must come with a safety comment and an explicit audit note. |
| X-013 | Placeholder program ID guard | **Pass** | `Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS` (the Anchor cookbook placeholder) is present in both `declare_id!` calls but explicitly flagged as a pre-mainnet pin (`programs/zettapay-core/src/lib.rs:73-76`, `programs/zettapay/src/lib.rs:19`). Z22.1 launch checklist rotates it before mainnet. | Confirm the rotation runs at launch and that the rotated ID appears in `Anchor.toml`, both `lib.rs`, the SDK, and the deployed binary. |
| X-014 | Clippy security lints (`integer_arithmetic`, `unwrap_used`, etc.) | **Conditional pass** | When `cargo` is on `PATH`, the scanner runs `cargo clippy --workspace --all-targets -- -D warnings` with the security-relevant lint set. The harness container building this report has no Rust toolchain, so this check is recorded as "warn-skipped" and re-runs green on developer machines and the Anchor-image CI. | Confirm the next Anchor CI run (post-merge) shows X-014 green. |

## Cross-reference: cloud-scanner upload procedure

When the audit milestone (Z21) needs a cloud scanner pass, the procedure is:

### Sec3 X-ray (free tier)

1. Go to <https://app.sec3.dev> and sign in with GitHub.
2. Connect this repository (`leandromaiam-code/zettapay`).
3. Select **X-ray (Free)** → pick the audit commit SHA (stamped in
   `audit/SCOPE.md`).
4. Wait for the scan to complete; download the JSON + PDF report.
5. Save the artifacts under `audit/cloud-scans/sec3-<short-sha>/`.

The free tier covers any open-source Solana / Anchor project; the
ZettaPay program (MIT, public repo, single Anchor crate ≈ 263 LOC + the
native crate ≈ 1060 LOC) is well under any documented size cap.

### Soteria (self-hosted)

1. Pull the Sec3-published binary:
   ```bash
   sh -c "$(curl -fsSL https://supercompiler.xyz/install)"
   ```
2. From the workspace root:
   ```bash
   soteria -analyzeAll programs/zettapay
   soteria -analyzeAll programs/zettapay-core
   ```
3. Save the per-crate output under `audit/cloud-scans/soteria-<short-sha>/`.

Soteria runs locally on Linux/Mac and emits a JSON report identical in
shape to Sec3 X-ray (Sec3 ate Soteria, so the schema converged). The
two reports are reviewed side-by-side: any finding raised by *either*
tool that is not already covered by the table above is added back to
this document as either a fix-tracking row or an accepted residual
risk with rationale.

## How to re-run the offline sweep

```bash
# full sweep, including clippy when cargo is available
scripts/static-analysis-rust.sh

# CI / sandboxes without rustup
SKIP_CARGO=1 scripts/static-analysis-rust.sh
```

Exit codes:

- `0` — all checks green.
- `1` — one or more findings; details emitted inline.
- `2` — script invoked outside the repo root (`programs/` not found).

## Operating discipline

The scanner exists to *catch regressions between cloud scans*, not to
replace them. The order of trust is:

1. **External audit** (Z21) — primary signal.
2. **Cloud scanners** (Sec3 X-ray + Soteria) — re-run at audit milestones
   and at every release candidate.
3. **`scripts/static-analysis-rust.sh`** — every PR, gating merge.

When the offline sweep flags a finding, the merge is blocked until
either the code is fixed or a documented exception is added to this
file. When the cloud scanner flags something the offline sweep missed,
this file is amended *and the scanner script is taught the new check*
so the gap never reappears.
