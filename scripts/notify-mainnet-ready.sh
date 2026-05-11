#!/usr/bin/env bash
# Notify the human operator (Leandro) via WhatsApp webhook that mainnet
# bytecode is built and ready to sign-and-deploy (Z29.1).
#
# Webhook contract is provider-agnostic — it just POSTs JSON to whatever
# URL is in WHATSAPP_WEBHOOK_URL. In practice this points at one of:
#
#   - Twilio WhatsApp Business: https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json
#   - Evolution API: https://<host>/message/sendText/<instance>
#   - Z-API: https://api.z-api.io/instances/<id>/token/<token>/send-text
#   - Meta Cloud API: https://graph.facebook.com/v18.0/<phone-id>/messages
#
# The JSON body is built to suit the WhatsApp Cloud API "text" message
# shape (the de-facto standard); operators using Twilio/Z-API should put a
# tiny shim webhook in front. Auth via `WHATSAPP_WEBHOOK_TOKEN` (Bearer).
#
# Idempotency: send is single-shot. Wrap in retry only if your provider
# returns 429 / 5xx — we deliberately don't retry here to avoid
# double-pinging the human at 3am.

set -euo pipefail

PROGRAM_NAME="zettapay"
META="target/deploy/${PROGRAM_NAME}.mainnet.json"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

: "${WHATSAPP_WEBHOOK_URL:?must be set to the WhatsApp webhook URL (Twilio/Evolution/Meta/Z-API)}"
: "${WHATSAPP_OPERATOR_NUMBER:?must be set to the recipient in E.164 format, e.g. +5511999999999}"
WHATSAPP_WEBHOOK_TOKEN="${WHATSAPP_WEBHOOK_TOKEN:-}"
WHATSAPP_FROM_NUMBER="${WHATSAPP_FROM_NUMBER:-}"

if [[ ! -f "${META}" ]]; then
  echo "FATAL: ${META} not found. Run scripts/build-mainnet.sh first." >&2
  exit 2
fi

# Parse the build metadata. We use python3 for robust JSON parsing without
# adding jq as a runtime dep — python3 is on every realistic host.
if ! command -v python3 >/dev/null 2>&1; then
  echo "FATAL: python3 not available; install it or vendor jq." >&2
  exit 127
fi

read -r SHA256 SIZE_BYTES BUILT_AT GIT_SHA < <(python3 - <<PY
import json
with open("${META}") as f:
    m = json.load(f)
print(m["sha256"], m["size_bytes"], m["built_at"], m["git_sha"])
PY
)

SIZE_KB=$(awk "BEGIN {printf \"%.1f\", ${SIZE_BYTES}/1024}")
SHA_SHORT="${SHA256:0:12}"

MESSAGE=$(cat <<EOF
ZettaPay mainnet bytecode pronto.

programa: ${PROGRAM_NAME}
tamanho: ${SIZE_KB} KB (${SIZE_BYTES} bytes)
sha256:  ${SHA_SHORT}…
git:     ${GIT_SHA:0:7}
built:   ${BUILT_AT}

proximo passo: rodar scripts/deploy-mainnet.sh com Phantom/keypair na maquina dedicada (custo ~5-6 SOL).
EOF
)

PAYLOAD=$(python3 - <<PY
import json, os
print(json.dumps({
    "messaging_product": "whatsapp",
    "to": os.environ["WHATSAPP_OPERATOR_NUMBER"],
    "from": os.environ.get("WHATSAPP_FROM_NUMBER") or None,
    "type": "text",
    "text": {"preview_url": False, "body": """${MESSAGE}"""},
}, separators=(",", ":")))
PY
)

CURL_ARGS=(-sS -X POST -H "Content-Type: application/json")
if [[ -n "${WHATSAPP_WEBHOOK_TOKEN}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${WHATSAPP_WEBHOOK_TOKEN}")
fi
CURL_ARGS+=(--data "${PAYLOAD}" "${WHATSAPP_WEBHOOK_URL}")

echo "==> POST ${WHATSAPP_WEBHOOK_URL}"
HTTP_CODE=$(curl -o /tmp/zettapay-notify-$$.json -w "%{http_code}" "${CURL_ARGS[@]}" || true)
RESPONSE_BODY=$(cat /tmp/zettapay-notify-$$.json 2>/dev/null || echo "")
rm -f /tmp/zettapay-notify-$$.json

echo "==> HTTP ${HTTP_CODE}"
if [[ -n "${RESPONSE_BODY}" ]]; then
  echo "    ${RESPONSE_BODY}" | head -c 500
  echo
fi

if [[ "${HTTP_CODE}" -lt 200 || "${HTTP_CODE}" -ge 300 ]]; then
  echo "FATAL: webhook returned ${HTTP_CODE}" >&2
  exit 6
fi

echo "==> Notification sent to ${WHATSAPP_OPERATOR_NUMBER}"
