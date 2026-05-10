# ZettaPay Twitter / X Surface

Public-facing X account is [@zettapay](https://x.com/zettapay). Outbound
posts are split into two flows:

1. **Manual posts** — launches, mainnet milestones, audits. Authored by
   the core team.
2. **Automated posts** — protocol milestones (TPV thresholds, new
   merchants, weekly devotion digest). Owned by [`bot/`](./bot).

## Why automate

DevRel and developer adoption are canon (premissa 25). Public progress
signals — "TPV crossed $1M", "X merchants live now" — are
trust signals for prospective merchants and agent builders deciding
whether to integrate the SDK. They also create natural retweet bait
inside the Solana ecosystem.

The cost of automation is low (one small bot, three drafts) and the
cadence is bounded by the stats themselves — no risk of spam during
quiet weeks.

## What the bot does NOT do

- Reply to mentions (community team handles that manually).
- DM users.
- Quote-tweet or retweet third parties.
- Read any private merchant data — it consumes only the public
  aggregate stats endpoint.

## Operator runbook

Setup, env vars, dry-run flow, and security notes live in the bot
[README](./bot/README.md). The short version:

1. Provision an X developer project with **Read and Write** permissions.
2. Generate OAuth 1.0a User Tokens for the @zettapay account.
3. Drop them into `bot/.env`, leave `DRY_RUN=true` for the first 24h,
   confirm the drafts in the logs read well, then flip to
   `DRY_RUN=false`.

## Future surfaces

The same milestone draft layer (`src/milestones.ts`) is the canonical
source for "something interesting just happened on-protocol" copy. As
we add Discord `#announcements` mirroring, Farcaster, or status-page
banners, they should consume the same drafts rather than re-implement
threshold logic.
