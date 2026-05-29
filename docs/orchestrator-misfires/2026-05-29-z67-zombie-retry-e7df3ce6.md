# Zombie re-issue — Z67 retry 2/3 (UUID e7df3ce6)

**Date:** 2026-05-29
**Mission UUID:** e7df3ce6
**Parent UUID (retry path):** d3e30330 → fc484ef8 (retry 1/3) → e7df3ce6 (retry 2/3)
**Mission name:** Z67 — Test-before-mainnet — unit/integration suite + signet/testnet support

## What happened

The orchestrator fired a **fifth** execution of Z67 — UUID `e7df3ce6`,
advertised as `AUTO-RETRY 2/3` of an intermediate parent `fc484ef8` which is
itself a retry of the original `d3e30330`. The original Z67 had already
shipped and merged days earlier.

Z67 history on `main`:

| PR    | Branch UUID prefix | State    | Notes                                            |
|-------|--------------------|----------|--------------------------------------------------|
| #304  | `d3e30330`         | MERGED   | Parent — landed `01f374b` as v0.1.3              |
| #305  | `ffbb6c92`         | OPEN     | Retry 1/3, byte-identical zombie of #304         |
| #306  | `56fd3eb4` (Z68)   | MERGED   | v0.1.5 hotfix on top of Z67's `isAllowedWebhookUrl` |
| #309  | `38c573f1`         | MERGED   | Sentinel — third firing, docs-only no-op         |
| —     | `fc484ef8`         | (no PR)  | Retry 1/3 — failed `loop_detected:Bash`, no PR opened |
| THIS  | `e7df3ce6`         | sentinel | Retry 2/3 — another no-op duplicate firing       |

Listener/sdk/widget/embed/receiver packages on main are at 0.1.4 (and 0.1.5
for listener after Z68). Z67's `0.1.2 → 0.1.3` bump is stale by two minor
versions.

## Why a sentinel instead of re-implementing

1. The full Z67 spec is already in `main` and verified by CI — re-executing
   would produce a third byte-identical PR (after #304 and #305) and conflict
   with the 0.1.4+/0.1.5 listener versions.
2. The orchestrator already opened a worker on this UUID and expects a PR.
   A silent no-op leaves the mission dangling.
3. Sentinel pattern established by #309 — preferred over merge-churn.

## What `main` already contains (Z67 acceptance criteria)

All six acceptance criteria in the Z67 spec are satisfied on `main` today:

1. CI workflow `.github/workflows/test.yml` — added in #304.
2. `zettapay-listener init --xpub vpub... --network signet` — supported (Z67 + Z68 hotfix).
3. `verify-config` detects vpub/network mismatch — added in #304.
4. `derive-address` with vpub yields `tb1q...` — added in #304.
5. Block explorer flow documented in `packages/listener/README.md` — added in #304.
6. Receiver-side HMAC contract validated by suite — added in #304 (`packages/receiver/test/*`).

## Retry-chain observation

The orchestrator now appears to mint a fresh UUID on each retry instead of
reusing the parent UUID:

- `d3e30330` (parent, shipped) → `ffbb6c92` (retry 1/3, zombie #305 OPEN) →
  `38c573f1` (retry 1/3 again, sentinel #309 MERGED)
- `fc484ef8` (a separate retry-1/3 attempt, no PR opened — `loop_detected`) →
  `e7df3ce6` (retry 2/3, this sentinel)

Two independent retry chains exist for the same shipped Z67 spec. The retry
bookkeeping does not appear to consult merged-PR state before firing.

## Recommended action

- Close this PR as a no-op sentinel.
- Close PR #305 (byte-identical zombie of merged #304).
- Investigate orchestrator retry logic: Z67 has now produced 5 firings of
  the same effective mission across at least 2 distinct parent UUIDs in
  3 days.
- Consider gating retry-firing on `gh pr list --search "<mission keyword>" --state merged`
  before spawning a worker.

## Related

- Memory: `project_z67_shipped.md`, `project_z67_zombie.md`
- Prior sentinel for same mission: `docs/orchestrator-misfires/2026-05-29-z67-zombie-retry-38c573f1.md`
- Companion narrative for #309: `docs/orchestrator-misfires/2026-05-29-z67-retry-uuid-38c573f1.md`
