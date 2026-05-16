---
mission_id: a872e5f5
sprint: Z29.4
status: ZOMBIE_REISSUE
canonical_pr: 186
prior_sentinel_pr: 198
reissue_count: 3
filed_at: 2026-05-16
---

# Z29.4 — Zombie re-issue sentinel (UUID `a872e5f5`)

## Summary

The orchestrator dispatched mission **Z29.4 · Programa LIVE mainnet** for a **third time** with a fresh UUID (`a872e5f5`). The canonical implementation is **already shipped in PR #186** (open since 2026-05-14) and a prior zombie sentinel was filed as PR #198 (UUID `78e8b768`, 2026-05-16). This sentinel records the third re-fire so it does not duplicate work or merge a parallel implementation.

## Canonical scope — already covered by PR #186

Branch `auto/6ad0334e-z29-4-programa-live-mainnet-fabric-pega`, title `feat(ops): mainnet program LIVE — getAccountInfo + protocol_config upsert + WhatsApp (Z29.4)`. The PR ships:

- Mainnet program activation script that reads the deployed Program ID
- `getAccountInfo` validation against the mainnet RPC
- Upsert into `zettapay_protocol_config` for the `mainnet` cluster
- WhatsApp success notification posted on completion

That is the full mission specification (effort ~15min, Sprint Z29, semi-manual mainnet deploy phase).

## Why this re-issue should not produce code

- Re-implementing the same flow on a third branch would create three parallel PRs racing to land into `zettapay_protocol_config` — duplicate `getAccountInfo` calls, duplicate WhatsApp notifications, conflicting config rows.
- The canonical PR #186 has been open and CLEAN since 2026-05-14; any refinement belongs there.
- The prior sentinel PR #198 already documented the duplicate dispatch for UUID `78e8b768`. This pattern of repeat re-fires for the same canonical sprint mission is tracked across the zombie sentinel log.

## Action

- This PR is a **sentinel** (this single Markdown file) so the orchestrator's mission-run row resolves to a merged/closed PR for UUID `a872e5f5` without shipping duplicate logic.
- Reviewer: close this sentinel (or merge as docs) once PR #186 has been merged. Do not merge alongside a fresh Z29.4 implementation.

## References

- Canonical PR: https://github.com/leandromaiam-code/zettapay/pull/186
- Prior sentinel: https://github.com/leandromaiam-code/zettapay/pull/198
- Sprint Z29 goal: "Programa Solana mainnet live. Fabric prepara, Leandro assina deploy com Phantom"
