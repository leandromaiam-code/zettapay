# Orchestrator misfire — VF-W2 routed to zettapay worktree

**Date:** 2026-05-23
**Mission UUID:** 2667b72c
**Mission name:** VF-W2 — Workspace creation fork (Genesis vs Adopt paths, UI + atomic bootstrap)
**Intended repo:** `leandromaiam-code/veridian-fabric`
**Actual worktree:** `leandromaiam-code/zettapay` (this repo)

## What happened

The Veridian Fabric orchestrator spawned mission VF-W2 in the zettapay
workspace. The mission body explicitly states:

> TARGET REPO: leandromaiam-code/veridian-fabric (NOT the zettapay repo).
> Clone, branch off main, edit, open PR back to main. Do not touch any
> zettapay-* code.

The mission scope assumes a Next.js 16 + Supabase + multi-tenant Fabric stack
(`src/app/(app)/new/` multi-step form, `fabric_core_workspaces`,
`fabric_workspace_onboarding`, GitHub/Supabase Management/Vercel API
orchestration, Claude CLI invocation for schema generation, RLS policies via
`auth.uid()`). None of those tables, routes, or abstractions exist in this
monorepo (Node/Express + Solana/EVM payment listeners with self-hosted
listener foundation as of Z55/Z56).

Executing here would corrupt zettapay.

This is the second VF-* misfire into zettapay today — VF-W1.1 (UUID
`0c2e81e4`) hit the same worktree earlier and was deflected via sentinel
PR #290 (still OPEN). The routing bug is recurring.

## Action taken

No mission code applied. This sentinel PR exists only to surface the misfire
to the orchestrator. Re-spawn VF-W2 against the correct repo.

## How to fix the routing

The Fabric workspace → repo mapping is still resolving `veridian-fabric`
workspace UUIDs to the zettapay clone. Until that mapping is corrected, every
VF-* mission will land here and need a sentinel deflection.

Audit the orchestrator's workspace registry / mission dispatch table; any
mission whose `target_repo` resolves to `leandromaiam-code/veridian-fabric`
must spawn inside a clone of that repo, not `/opt/fabric-workspaces/zettapay`.
