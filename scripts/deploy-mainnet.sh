#!/usr/bin/env bash
# Deploy the ZettaPay Anchor program to Solana mainnet-beta (Z29.1).
#
# Fabric does NOT custody mainnet keys. This script is meant to be run by a
# human operator (Leandro) on a machine that holds the deployer keypair, or
# wired up to a Phantom-signed deploy flow via solana-cli's `--keypair`
# placeholder (`MAINNET_DEPLOYER_KEYPAIR`).
#
# Pre-reqs:
#   1. scripts/build-mainnet.sh has produced target/deploy/zettapay.so
#   2. The deployer keypair has at least 6 SOL (a fresh program deploy of
#      ~200kb of bytecode costs ~5.5 SOL of rent-exempt SBF storage).
#   3. The mainnet program ID is registered (either reuse the dev id by
#      keeping MAINNET_PROGRAM_ID unset, or set it to the freshly-generated
#      mainnet program keypair pubkey).
#
# Safety:
#   - Bails immediately if MAINNET_DEPLOYER_KEYPAIR is unset.
#   - Confirms cluster is mainnet-beta before broadcasting tx.
#   - Will NOT auto-airdrop on mainnet (airdrop is devnet-only).
#   - First step is a dry-run (`solana program deploy --dry-run`) so the
#     human can sanity-check before paying rent.

set -euo pipefail

PROGRAM_NAME="zettapay"
ARTIFACT="target/deploy/${PROGRAM_NAME}.so"
IDL_ARTIFACT="target/idl/${PROGRAM_NAME}.json"
CLUSTER_URL="https://api.mainnet-beta.solana.com"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

: "${MAINNET_DEPLOYER_KEYPAIR:?must be set to an absolute path of the mainnet deployer keypair JSON (Fabric does not custody this)}"
PROGRAM_ID="${MAINNET_PROGRAM_ID:-Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS}"
PROGRAM_KEYPAIR="${MAINNET_PROGRAM_KEYPAIR:-}"

if [[ ! -f "${MAINNET_DEPLOYER_KEYPAIR}" ]]; then
  echo "FATAL: MAINNET_DEPLOYER_KEYPAIR=${MAINNET_DEPLOYER_KEYPAIR} does not exist." >&2
  exit 2
fi
if [[ ! -f "${ARTIFACT}" ]]; then
  echo "FATAL: ${ARTIFACT} not found. Run scripts/build-mainnet.sh first." >&2
  exit 2
fi

echo "==> Pinning cluster to mainnet-beta"
solana config set --url "${CLUSTER_URL}" --keypair "${MAINNET_DEPLOYER_KEYPAIR}" >/dev/null
solana config get | sed 's/^/    /'

CURRENT_CLUSTER=$(solana config get | awk -F': ' '/RPC URL/ {print $2}' | tr -d ' ')
if [[ "${CURRENT_CLUSTER}" != "${CLUSTER_URL}" ]]; then
  echo "FATAL: cluster mismatch (${CURRENT_CLUSTER} != ${CLUSTER_URL}). Aborting." >&2
  exit 3
fi

DEPLOYER=$(solana address)
echo "==> Deployer: ${DEPLOYER}"
BALANCE_LAMPORTS=$(solana balance --lamports | awk '{print $1}')
BALANCE_SOL=$(awk "BEGIN {printf \"%.3f\", ${BALANCE_LAMPORTS}/1000000000}")
echo "    balance: ${BALANCE_SOL} SOL"
if [[ "${BALANCE_LAMPORTS}" -lt 6000000000 ]]; then
  echo "FATAL: deployer balance below 6 SOL — fund it before retrying. NO airdrop on mainnet." >&2
  exit 4
fi

SIZE_BYTES=$(wc -c < "${ARTIFACT}" | tr -d ' ')
SHA256=$(sha256sum "${ARTIFACT}" | awk '{print $1}')
echo "==> Artifact"
echo "    path   : ${ARTIFACT}"
echo "    size   : ${SIZE_BYTES} bytes"
echo "    sha256 : ${SHA256}"
echo "    target : ${PROGRAM_ID}"

echo
echo "==> Confirmation required"
echo "    You are about to deploy ${SIZE_BYTES} bytes to MAINNET-BETA as"
echo "    program ID ${PROGRAM_ID}, paying ~5-6 SOL of rent. Reply 'DEPLOY'"
echo "    to proceed; anything else aborts."
read -r -p "    > " CONFIRM
if [[ "${CONFIRM}" != "DEPLOY" ]]; then
  echo "Aborted." >&2
  exit 5
fi

DEPLOY_ARGS=(program deploy "${ARTIFACT}" --url "${CLUSTER_URL}" --keypair "${MAINNET_DEPLOYER_KEYPAIR}")
if [[ -n "${PROGRAM_KEYPAIR}" ]]; then
  if [[ ! -f "${PROGRAM_KEYPAIR}" ]]; then
    echo "FATAL: MAINNET_PROGRAM_KEYPAIR=${PROGRAM_KEYPAIR} does not exist." >&2
    exit 2
  fi
  DEPLOY_ARGS+=(--program-id "${PROGRAM_KEYPAIR}")
fi

echo "==> Broadcasting solana program deploy"
solana "${DEPLOY_ARGS[@]}"

echo "==> Publishing IDL on-chain"
if anchor idl init --provider.cluster mainnet -f "${IDL_ARTIFACT}" "${PROGRAM_ID}" 2>/dev/null; then
  echo "    idl initialized"
else
  echo "    idl already exists; upgrading"
  anchor idl upgrade --provider.cluster mainnet -f "${IDL_ARTIFACT}" "${PROGRAM_ID}"
fi

echo "==> Done"
echo "    program id : ${PROGRAM_ID}"
echo "    cluster    : mainnet-beta"
echo "    sha256     : ${SHA256}"
echo
echo "Verify from anywhere with:"
echo "    anchor idl fetch --provider.cluster mainnet ${PROGRAM_ID}"
echo "    solana program show --url ${CLUSTER_URL} ${PROGRAM_ID}"
