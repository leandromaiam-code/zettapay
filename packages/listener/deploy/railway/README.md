# Deploying @zettapay/listener on Railway

One-click button (replace `<owner>/<repo>` with your fork):

```
https://railway.app/new/template?template=https://github.com/<owner>/<repo>&envs=MERCHANT_WEBHOOK_URL,MERCHANT_WEBHOOK_SECRET,STORAGE
```

## Manual setup (5 min)

1. `railway init` (or **New Project → Deploy from GitHub Repo**) and point at the
   fork that contains `packages/listener/`.
2. Set the build root to the repo root — `railway.json` lives at
   `packages/listener/deploy/railway/railway.json` and tells Railway to build
   `packages/listener/Dockerfile` with `packages/listener` as the build context.
   If your Railway service is configured per-package, copy `railway.json` to the
   service root and drop the `buildContext` field.
3. Add service variables:
   - `MERCHANT_WEBHOOK_URL` — your backend's webhook receiver (HTTPS).
   - `MERCHANT_WEBHOOK_SECRET` — strong random string. Keep it in Railway's
     **Secrets**, not in `.env`.
   - `STORAGE` — pick one:
     - `json` (default) — needs a Railway **Volume** mounted at `/data` so state
       survives redeploys.
     - `sqlite` — same as JSON: mount a volume at `/data`.
     - `supabase` — set `SUPABASE_URL` + `SUPABASE_SERVICE_KEY`. No volume.
     - `postgres` — link a Railway Postgres plugin, expose `DATABASE_URL`.
4. Expose the service. Railway maps `$PORT` automatically; the listener listens
   on `HEALTH_PORT` (default `8787`). For Railway public exposure, set
   `HEALTH_PORT=$PORT` in the variables.
5. Health check is wired to `/health` via `railway.json`. The deploy fails fast
   if the listener does not bind within 30 s.

## Volumes (json / sqlite only)

```
railway volume create --mount-path /data --size 1
```

Without a volume, JSON / SQLite state is lost on every redeploy.

## Logs

```
railway logs --service zettapay-listener --follow
```

## Why this still respects HR-PHONE-HOME

Railway is **the merchant's** infrastructure. The listener talks to
`mempool.space`, the merchant's `MERCHANT_WEBHOOK_URL`, and (optionally) the
merchant's chosen storage backend. It never contacts a ZettaPay-controlled host.
