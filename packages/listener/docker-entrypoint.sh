#!/bin/sh
# @zettapay/listener container entrypoint — plug-and-play.
# On first boot (no merchant in storage), auto-seed a merchant from env vars,
# then start the watcher + HTTP API. Idempotent: skips seeding if already done.
set -e

DATA_DIR="${ZETTAPAY_DATA_DIR:-/data}"
MERCHANT_FILE="$DATA_DIR/merchant.json"

if [ ! -f "$MERCHANT_FILE" ]; then
  if [ -z "$MERCHANT_XPUB" ]; then
    echo "zettapay-listener: MERCHANT_XPUB is required on first boot (to seed the merchant)." >&2
    exit 1
  fi
  echo "zettapay-listener: first boot — seeding merchant from env into $DATA_DIR"
  node /app/dist/cli/init.js \
    --xpub "$MERCHANT_XPUB" \
    --network "${MERCHANT_NETWORK:-mainnet}" \
    --webhook-url "${MERCHANT_WEBHOOK_URL:-https://example.com/webhook}" \
    --shop-name "${MERCHANT_SHOP_NAME:-merchant}" \
    --email "${MERCHANT_EMAIL:-noreply@example.com}" \
    --storage "${STORAGE:-json}" \
    --data-dir "$DATA_DIR" \
    --force || { echo "zettapay-listener: init failed" >&2; exit 1; }
fi

# Export the seeded merchant id so `start` binds to it (init prints it; we also
# read it back from merchant.json to be safe).
if [ -f "$MERCHANT_FILE" ] && [ -z "$MERCHANT_ID" ]; then
  MID=$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$MERCHANT_FILE','utf8')).id||'')}catch(e){}")
  if [ -n "$MID" ]; then export MERCHANT_ID="$MID"; fi
fi

exec node /app/dist/main.js start
