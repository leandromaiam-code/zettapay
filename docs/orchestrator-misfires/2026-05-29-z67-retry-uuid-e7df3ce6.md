# Z67 zombie re-issue — UUID e7df3ce6 (retry 2/3)

**Date:** 2026-05-29
**Mission UUID:** `e7df3ce6` (retry 2/3, parent `fc484ef8` → which was retry 1/3 of `d3e30330`)
**Branch:** `auto/e7df3ce6--retry-2-3-retry-1-3-z67-test-before-mai`
**Status:** sentinel — no code changes

## What happened

Orchestrator fired Z67 a **fourth time** for the same spec already delivered by PR #304 (parent UUID `d3e30330`, merged 2026-05-27 23:19 UTC). Prior firings:

| Firing | UUID | PR | State |
|--------|------|-----|-------|
| parent | `d3e30330` | #304 | MERGED 2026-05-27 |
| retry 1/3 | `ffbb6c92` | #305 | OPEN (zombie dup) |
| retry 1/3 (re-fire) | `38c573f1` | #309 | MERGED 2026-05-29 (sentinel) |
| **retry 2/3 (this)** | **`e7df3ce6`** | **this PR** | **sentinel** |

## Verification of zombie status

All Z67 scope items present on `main`:

| Spec deliverable | Location on main | First shipped in |
|---|---|---|
| `derive.test.ts` (BIP-84 vectors) | `packages/listener/test/derive.test.ts` | #304 |
| `hmac.test.ts` (sign+verify, timing-safe, replay) | `packages/listener/test/hmac.test.ts` | #304 |
| `listener-integration.test.ts` (mock mempool WS) | `packages/listener/test/listener-integration.test.ts` | #304 |
| `storage-atomicity.test.ts` (100 parallel allocations) | `packages/listener/test/storage-atomicity.test.ts` | #304 |
| `NETWORK_CONFIG` (mainnet/testnet/signet/regtest) | `packages/listener/src/network.ts` | #304 |
| `derive-address` honors network | `packages/listener/src/cli/derive-address.ts` | #304 |
| `init --network` flag | `packages/listener/src/cli/init.ts` | #304 |
| `verify-config` network match check | `packages/listener/src/cli/verify-config.ts` | #304 |
| README "Testing before mainnet" section | `packages/listener/README.md` | #304 |
| `.github/workflows/test.yml` | present | #304 |
| Version bump → `0.1.3` | `packages/listener/package.json` | #304 |

Subsequent commits on `main` evolved the listener further:
- `da1cd34` — bumped all packages to `0.1.4`
- `d0282e4` — Z68 hotfix → listener `0.1.5` (`init.ts` now honors `isAllowedWebhookUrl` via shared `classifyWebhookUrl`)
- `4ca8b82` — Z67 retry sentinel for UUID `38c573f1`

Re-applying Z67 v0.1.3 would either (a) revert the v0.1.5 hotfix, or (b) produce an empty diff. Neither is acceptable, so this PR ships docs only.

## Worktree note

`/tmp/fabric-work-aa5faadd549e` carried staged WIP from the failed `fc484ef8` retry (5 modified `src/` files + 4 untracked test files). Diff confirmed these reproduce what's already in `#304`, so they were discarded via `git reset --hard origin/main` + `git clean -fd packages/listener/`.

## Action for orchestrator

Treat parent `d3e30330` as **shipped** and stop retry-chain firings. The AUTO-RETRY ladder
(`d3e30330` → `fc484ef8` → `e7df3ce6`) is amplifying the same zombie. Recommendation: gate
retries on `gh pr list --search "<mission title>"` and short-circuit if a MERGED PR exists.
