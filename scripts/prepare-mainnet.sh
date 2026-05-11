#!/usr/bin/env bash
# Z29.1 orchestrator: build mainnet bytecode + ping the operator on
# WhatsApp once the artifact is verifiable.
#
# Steps:
#   1. scripts/build-mainnet.sh — compiles target/deploy/zettapay.so
#   2. scripts/notify-mainnet-ready.sh — posts to WHATSAPP_WEBHOOK_URL
#
# The actual deploy step is NOT automated — Leandro signs with Phantom
# (or hardware) on a separate machine. See scripts/deploy-mainnet.sh.
#
# Env (notification is skipped if either is unset, so dev-only runs work):
#   WHATSAPP_WEBHOOK_URL       provider webhook URL
#   WHATSAPP_OPERATOR_NUMBER   E.164 recipient
#   WHATSAPP_WEBHOOK_TOKEN     optional bearer token
#   WHATSAPP_FROM_NUMBER       optional sender (Meta Cloud)

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

echo "==> 1/2 build"
bash scripts/build-mainnet.sh

echo
echo "==> 2/2 notify"
if [[ -z "${WHATSAPP_WEBHOOK_URL:-}" || -z "${WHATSAPP_OPERATOR_NUMBER:-}" ]]; then
  echo "    SKIP — set WHATSAPP_WEBHOOK_URL + WHATSAPP_OPERATOR_NUMBER to enable WhatsApp ping"
  echo "    Artifact still ready at target/deploy/zettapay.so"
  exit 0
fi
bash scripts/notify-mainnet-ready.sh

echo
echo "==> prepare-mainnet complete"
echo "    Next: scripts/deploy-mainnet.sh on the deployer machine (Phantom/keypair signed)"
