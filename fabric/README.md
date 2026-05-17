# Fabric HR-* Guardrails (reference implementation)

Defensive layer that makes it **impossible for custodial / non-compliant
code to pass through the Fabric autodev pipeline** — even when a mission
spec is authored incorrectly by a human or an upstream agent.

The original incident: spec **Z51** was authored by an LLM and shipped a
custodial wallet (`TREASURY_PRIVATE_KEY` + `KeyManager.sign*`) into
ZettaPay, silently violating its non-custodial positioning. Fabric
executed the spec faithfully because nothing in the pipeline understood
the invariant being broken.

## What ships here

| Component | Location | Where it runs |
|---|---|---|
| Hard Rule schema migration | `migrations/0001_hr_columns.sql` | Fabric control-plane Postgres |
| ZettaPay HR seeds (4 rules) | `seed/zettapay_hrs.sql` + `seed/zettapay_hrs.json` | Postgres + scanners |
| Preflight gate (LLM-based) | `lib/preflight.js` | `POST /execute-mission` |
| Self-healing spec loop | `lib/self-heal.js` | called from preflight on VIOLATE |
| Intent-to-mission endpoint | `lib/intent.js` + `bin/intent-to-mission.js` | `POST /intent-to-mission` |
| Pre-merge regex scan | `lib/scan.js` + `../scripts/hr-scan.mjs` + `../.github/workflows/hr-scan.yml` | GitHub Actions on every PR |
| Post-merge auto-revert | `bin/postscan.js` + `systemd/fabric-hr-postscan.{service,timer}` | hourly on Fabric host |
| HR learning cron | `bin/hr-learning.js` + `systemd/fabric-hr-learning.{service,timer}` | daily on Fabric host |
| Operator audit tail | `bin/check-hr-audit.sh` | manual / `/opt/jarvisai/scripts/` |

## Architecture

```
                    ┌────────────────────────────────────────┐
   POST /intent →   │  intentToMission()                     │
                    │     ├─ load HRs + Layer 0 + history     │
                    │     ├─ Claude expand intent → spec      │
                    │     └─ preflightCheck()                 │
                    └────────────────────┬───────────────────┘
                                         │ pass
                                         ▼
   POST /execute-mission                                   ┌───────────────┐
   ──────────────────────►  preflightCheck(mission, {sb}) ─►  PASS?         │
                                  ▲                       │   yes → spawn  │
                                  │                       │   no  → heal   │
                            Claude CLI (-p)               └───────────────┘
                                  │
                                  ▼
                            selfHealSpec()  ──► PATCH mission, retry preflight (≤3)
                                                                │
                                                                ▼
                                              if still VIOLATE: 412 to caller
                                              + audit_journal entry

   GitHub PR opened  ────►  .github/workflows/hr-scan.yml
                                  ▼
                              scripts/hr-scan.mjs diff origin/main...HEAD
                                  ▼
                              annotations + non-zero exit on hard/blocker

   Hourly on Fabric host ──►  fabric-hr-postscan.timer
                                  ▼
                              bin/postscan.js
                                  ├─ git log since last sha
                                  ├─ scan added lines
                                  └─ open auto-revert PR + audit

   Daily on Fabric host ───►  fabric-hr-learning.timer
                                  ▼
                              bin/hr-learning.js
                                  ├─ load last 7 days of audit
                                  ├─ Claude propose new soft HRs
                                  └─ insert (severity=soft) for human review
```

## Install (Fabric host)

See [`server-patch.md`](./server-patch.md) for the full deployment runbook.

TL;DR:
1. `psql -f migrations/0001_hr_columns.sql` then `-f seed/zettapay_hrs.sql`
2. `install` the `lib/` and `bin/` files under `/opt/veridian-fabric/`
3. Patch `/opt/fabric-api/server.js` with the snippets from `server-patch.md`
4. Install + enable the two systemd timers
5. Smoke: `echo '{...bad spec...}' | node /opt/veridian-fabric/fabric/bin/preflight.js --stdin`

## Authoring new HR-*

```sql
INSERT INTO public.fabric_layer0_premissas
  (id, workspace_id, premissa_kind, severity, title, body, detection_patterns)
VALUES (
  '<workspace>:HR-<short-id>',
  '<workspace_id>',
  'HR',
  'soft' | 'hard' | 'blocker',
  '<short title>',
  '<rule body — full sentences, future-readers will see this in PR comments>',
  '["<regex>", "<regex>", ...]'::jsonb
);
```

Severities:
- `soft` — preflight emits warning, scanners report but do not block.
- `hard` — preflight `VIOLATE` blocks dispatch; pre-merge scan blocks merge;
  post-merge scan files auto-revert PR. PR-label override (`hr-override:HR-X`)
  is available for emergency human overrides.
- `blocker` — same as hard, plus cannot be overridden.

Detection patterns are JavaScript regex strings (case-insensitive). They run
against added lines only (in CI diff mode and post-merge scan), so existing
violations do not regress the gate — they require explicit cleanup missions.

## Override

The hourly post-merge scan and PR gate honour:
- Env `ALLOW_HR_OVERRIDE=HR-X,HR-Y` (set by mission orchestrator or workflow)
- PR labels `hr-override:HR-X` (workflow maps to env)

`blocker` severity is **not overridable** by design. Adjust the rule's
severity to `hard` first if you genuinely need an override.

## Why these are not optional

A 32-line Layer 0 doc that says "non-custodial" can be silently violated
by 50 lines of `privateKeyToAccount(...)` because nothing reads the doc at
build time. HR-* are the same invariants written as machine-checkable
regex + LLM-evaluated semantics, enforced at four independent gates:

1. **Pre-dispatch** (preflightCheck before claude-code spawn)
2. **Pre-merge** (GitHub Actions on PR diff)
3. **Post-merge** (hourly cron auto-revert)
4. **Learning** (daily cron proposes new soft HRs from recurring violations)

A spec, a PR, or a merged commit each face an independent guardrail. To
ship custodial code now requires explicitly setting `ALLOW_HR_OVERRIDE`
for `HR-CUSTODY` AND merging during an outage of the post-merge cron AND
no one reading the audit journal.
