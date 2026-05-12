#!/usr/bin/env bash
# Z29.3: poll Solana mainnet-beta until a given deploy tx signature is
# finalized (or until it errs / times out after 5 minutes).
#
# Mirrors the dashboard-side polling loop documented in
# docs/operations/mainnet-deploy-phantom-dashboard.mdx so on-call can
# re-run the same monitor from a terminal if the dashboard session
# drops mid-flight.
#
# Exit codes:
#   0 — tx finalized successfully
#   1 — tx finalized with an on-chain error
#   2 — bad arguments / missing dependency
#   3 — tx not seen on-chain after 5 minutes (blockhash expired)
#
# Usage:
#   bash scripts/monitor-mainnet-deploy.sh <tx-signature>
#   RPC_URL=https://my-private-rpc bash scripts/monitor-mainnet-deploy.sh <sig>

set -euo pipefail

SIGNATURE="${1:-}"
RPC_URL="${RPC_URL:-https://api.mainnet-beta.solana.com}"
TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-300}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

if [[ -z "${SIGNATURE}" ]]; then
  echo "usage: $0 <tx-signature>" >&2
  exit 2
fi
if ! command -v curl >/dev/null 2>&1; then
  echo "FATAL: curl not installed." >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "FATAL: jq not installed." >&2
  exit 2
fi

echo "==> Monitoring tx ${SIGNATURE}"
echo "    rpc      : ${RPC_URL}"
echo "    timeout  : ${TIMEOUT_SECONDS}s"
echo "    interval : ${POLL_INTERVAL}s"

START_TS=$(date +%s)
LAST_STATE=""

while true; do
  NOW_TS=$(date +%s)
  ELAPSED=$(( NOW_TS - START_TS ))
  if [[ ${ELAPSED} -ge ${TIMEOUT_SECONDS} ]]; then
    echo "==> Timed out after ${TIMEOUT_SECONDS}s — tx never landed (blockhash expired?). Re-broadcast." >&2
    exit 3
  fi

  RESPONSE=$(curl -sS -X POST "${RPC_URL}" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg sig "${SIGNATURE}" '{
      jsonrpc: "2.0",
      id: 1,
      method: "getSignatureStatuses",
      params: [[$sig], {searchTransactionHistory: true}]
    }')")

  STATUS=$(echo "${RESPONSE}" | jq -r '.result.value[0]')

  if [[ "${STATUS}" == "null" || -z "${STATUS}" ]]; then
    STATE="pending"
  else
    ERR=$(echo "${RESPONSE}" | jq -r '.result.value[0].err')
    CONFIRMATION=$(echo "${RESPONSE}" | jq -r '.result.value[0].confirmationStatus // "processed"')
    if [[ "${ERR}" != "null" ]]; then
      echo "==> Tx reverted on-chain: ${ERR}" >&2
      echo "    https://solscan.io/tx/${SIGNATURE}" >&2
      exit 1
    fi
    STATE="${CONFIRMATION}"
  fi

  if [[ "${STATE}" != "${LAST_STATE}" ]]; then
    printf '    [%3ds] %s\n' "${ELAPSED}" "${STATE}"
    LAST_STATE="${STATE}"
  fi

  if [[ "${STATE}" == "finalized" ]]; then
    echo "==> Finalized"
    echo "    https://solscan.io/tx/${SIGNATURE}"
    exit 0
  fi

  sleep "${POLL_INTERVAL}"
done
