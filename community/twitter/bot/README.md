# ZettaPay Twitter/X Bot

Auto-posts protocol milestones to [@zettapay](https://x.com/zettapay):

- **TPV thresholds** — `$10K`, `$50K`, `$100K`, `$1M`, `$10M`, `$100M`, …
- **New merchants** — welcome shout-out when a merchant goes live
- **Weekly devotion digest** — active subscriptions + lifetime payments

The bot is a small standalone Node process. It polls the public ZettaPay
stats endpoint, decides whether any milestone has tripped, and posts via
the X API v2 with OAuth 1.0a User Context.

## Run

```bash
cd community/twitter/bot
cp .env.example .env
# fill in TWITTER_* keys (or leave DRY_RUN=true to test without posting)
npm install
npm run build
npm start
```

For a single milestone check (useful from cron):

```bash
npm run tick
```

## Environment

See [`.env.example`](./.env.example). The only mandatory vars (when
`DRY_RUN=false`) are the four `TWITTER_*` OAuth 1.0a credentials. The bot
reads platform stats from `ZETTAPAY_API_BASE` (defaults to
`https://api.zettapay.io`) — that endpoint must expose
`GET /v1/public/stats` with the shape declared in
[`src/stats.ts`](./src/stats.ts).

## Milestone semantics

- **TPV thresholds are one-shot per band.** Once `$1M` fires, the bot
  records the current TPV as the watermark and never posts a `$1M` band
  again — even if TPV briefly dips and recovers.
- **First run is silent.** The bot seeds its state from the current
  platform numbers so it never floods the timeline with retroactive
  milestones on day one.
- **Merchants are announced once.** Identified by stable merchant `id`
  from the stats endpoint, capped at 500 most-recent in `state.json` to
  bound disk usage.
- **Devotion digest fires once per week** on the configured weekday/hour
  in UTC (`WEEKLY_DIGEST_AT=1,15` → Monday 15:00 UTC). A 6-day floor
  prevents double-firing if the bot is restarted within the same hour.

## Operational notes

- **State file (`state.json`)** is the source of truth for what has been
  posted. Do not delete it without understanding the consequence — the
  next tick will treat the platform as a first-run and re-seed silently,
  meaning any genuinely new milestone since the deletion will be
  swallowed. Keep backups across redeploys.
- **Rate limits.** The bot posts at most three tweets per tick (one per
  milestone kind). Default 10-minute poll interval keeps us comfortably
  under the X API free-tier quota.
- **Dry-run by default.** Flip `DRY_RUN=false` only after reviewing
  staging logs and the wording of recent drafts.
- **Brand voice.** No "revolution", "disruption", "synergy",
  "game-changer" — same constraint as the rest of ZettaPay copy.
- **No private data.** The bot trusts only the fields declared in
  `PlatformStats` — it cannot leak payer wallets, per-merchant revenue,
  or anything else not exposed by `/v1/public/stats`.

## Security

- **OAuth 1.0a credentials** never touch the repo. They live in `.env`
  (gitignored) or your secret manager of choice.
- The signing implementation in [`src/twitter.ts`](./src/twitter.ts) uses
  Node's built-in `crypto` — no third-party Twitter SDK is on the
  attack surface.
- The bot has no inbound network footprint. It only makes outbound HTTPS
  calls to `api.twitter.com` and `ZETTAPAY_API_BASE`.

## Future work

- Threaded posts for big milestones (e.g. $100M crossing → multi-tweet
  thread with a chart screenshot).
- Source-of-truth move from polling to the webhook fan-out (Z9.5
  on-chain receipts) so TPV milestones fire within seconds of the
  on-chain event rather than within a 10-minute poll window.
- Mirror to other surfaces (Discord `#announcements`, Farcaster) once
  the milestone draft layer stabilises.
