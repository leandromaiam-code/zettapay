#!/usr/bin/env bash
# Z25.4 — automated devnet deploy of `zettapay-core` (native Solana program,
# no Anchor; programs/zettapay-core/Cargo.toml).
#
# Pipeline:
#   1. cargo build-sbf                       (BPF artifact at target/deploy/zettapay_core.so)
#   2. solana-keygen new --outfile devnet-keypair.json   (deployer; idempotent — reuses if present)
#   3. solana airdrop 5 --url devnet                     (skipped if balance already ≥ 5 SOL)
#   4. solana program deploy ...             (idempotent: upgrades in place if program keypair exists)
#   5. persist Program ID in `zettapay_protocol_config` table
#                                            (npm run -s persist:program-id -- --cluster devnet ...)
#
# Idempotency:
#   - Re-running reuses existing keypairs (`devnet-keypair.json` and the
#     program keypair at `target/deploy/zettapay_core-keypair.json` that
#     `cargo build-sbf` generates on first build).
#   - The protocol_config row is upserted on `(program_name, cluster)`.
#
# Premise alignment:
#   • Premise 1 (Solana V1): cluster is hard-pinned to devnet.
#   • Premise 13 (Postgres in prod): writes to ZETTAPAY_DB_PATH (SQLite
#     locally; Supabase migration `20260513000000_zettapay_protocol_config.sql`
#     is the prod mirror).
#   • Premise 16 (mainnet only after audit): this script REFUSES to run
#     against any cluster other than devnet — mainnet still goes through
#     scripts/deploy-mainnet.sh with a human-signed keypair.
#   • Premise 30 (effort minutes): full devnet bring-up in <30min on a
#     warm cargo cache.
#
# Pre-reqs (host machine, NOT Vercel CI — there is no Rust toolchain on
# the serverless build path):
#   - solana-cli >= 1.18.26
#   - rustc + cargo with the solana-platform-tools (cargo-build-sbf)
#   - tsx (provided transitively by the workspace devDependencies)
#
# Env (all optional unless noted):
#   ZETTAPAY_PROGRAM_KEYPAIR     override the program keypair path
#   ZETTAPAY_DEPLOYER_KEYPAIR    override the deployer keypair path
#                                (default: ./devnet-keypair.json)
#   ZETTAPAY_DB_PATH             SQLite path for persistence
#                                (default: ./data/zettapay.sqlite)
#   SKIP_PERSIST                 "1" to skip the DB upsert step
#   SKIP_AIRDROP                 "1" to refuse the airdrop step
#                                (useful when the deployer is already funded)

set -euo pipefail

PROGRAM_NAME="zettapay-core"
PROGRAM_CRATE="zettapay-core"
ARTIFACT_FILENAME="zettapay_core.so"          # cargo-build-sbf substitutes - → _
PROGRAM_KEYPAIR_FILENAME="zettapay_core-keypair.json"
CLUSTER="devnet"
CLUSTER_URL="https://api.devnet.solana.com"
AIRDROP_SOL=5
MIN_BALANCE_LAMPORTS=$((AIRDROP_SOL * 1000000000))

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

ARTIFACT_DIR="${ROOT_DIR}/target/deploy"
ARTIFACT="${ARTIFACT_DIR}/${ARTIFACT_FILENAME}"
PROGRAM_KEYPAIR="${ZETTAPAY_PROGRAM_KEYPAIR:-${ARTIFACT_DIR}/${PROGRAM_KEYPAIR_FILENAME}}"
DEPLOYER_KEYPAIR="${ZETTAPAY_DEPLOYER_KEYPAIR:-${ROOT_DIR}/devnet-keypair.json}"

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "FATAL: required tool '$1' not on PATH." >&2
    exit 127
  fi
}

require solana
require solana-keygen
require cargo

echo "==> Toolchain"
echo "    solana : $(solana --version 2>/dev/null | awk '{print $2}')"
echo "    rustc  : $(rustc --version 2>/dev/null | awk '{print $2}')"

# ---------------------------------------------------------------------------
# 1. cargo build-sbf
# ---------------------------------------------------------------------------
echo "==> cargo build-sbf (programs/${PROGRAM_NAME})"
cargo build-sbf \
  --manifest-path "programs/${PROGRAM_CRATE}/Cargo.toml" \
  --sbf-out-dir "${ARTIFACT_DIR}"

if [[ ! -f "${ARTIFACT}" ]]; then
  echo "FATAL: expected artifact ${ARTIFACT} not produced." >&2
  exit 1
fi

SIZE_BYTES=$(wc -c < "${ARTIFACT}" | tr -d ' ')
SHA256=$(sha256sum "${ARTIFACT}" | awk '{print $1}')
echo "    artifact : ${ARTIFACT}"
echo "    size     : ${SIZE_BYTES} bytes"
echo "    sha256   : ${SHA256}"

# ---------------------------------------------------------------------------
# 2. solana-keygen new --outfile devnet-keypair.json (idempotent)
# ---------------------------------------------------------------------------
if [[ ! -f "${DEPLOYER_KEYPAIR}" ]]; then
  echo "==> solana-keygen new --outfile ${DEPLOYER_KEYPAIR}"
  solana-keygen new \
    --no-bip39-passphrase \
    --silent \
    --outfile "${DEPLOYER_KEYPAIR}"
else
  echo "==> Reusing existing deployer keypair (${DEPLOYER_KEYPAIR})"
fi

# Pin CLI to devnet + the deployer keypair so subsequent commands inherit
# the cluster + signer (avoids repeating --url/--keypair on every call).
solana config set \
  --url "${CLUSTER_URL}" \
  --keypair "${DEPLOYER_KEYPAIR}" \
  >/dev/null
CURRENT_CLUSTER=$(solana config get | awk -F': ' '/RPC URL/ {print $2}' | tr -d ' ')
if [[ "${CURRENT_CLUSTER}" != "${CLUSTER_URL}" ]]; then
  echo "FATAL: cluster pin failed (${CURRENT_CLUSTER} != ${CLUSTER_URL}). Aborting." >&2
  exit 3
fi

DEPLOYER_PUBKEY=$(solana address)
echo "    deployer pubkey: ${DEPLOYER_PUBKEY}"

# ---------------------------------------------------------------------------
# 3. solana airdrop 5 --url devnet (skipped if already funded)
# ---------------------------------------------------------------------------
BALANCE_LAMPORTS=$(solana balance --lamports | awk '{print $1}')
echo "==> Balance: ${BALANCE_LAMPORTS} lamports (need ≥ ${MIN_BALANCE_LAMPORTS})"

if [[ "${BALANCE_LAMPORTS}" -ge "${MIN_BALANCE_LAMPORTS}" ]]; then
  echo "    already funded; skipping airdrop"
elif [[ "${SKIP_AIRDROP:-0}" == "1" ]]; then
  echo "FATAL: deployer under-funded and SKIP_AIRDROP=1. Fund ${DEPLOYER_PUBKEY} manually." >&2
  exit 4
else
  echo "==> solana airdrop ${AIRDROP_SOL} --url ${CLUSTER}"
  # Devnet faucets rate-limit aggressively; tolerate partial drops by
  # re-checking the balance, and only fail if we're STILL underfunded.
  if ! solana airdrop "${AIRDROP_SOL}" --url "${CLUSTER}"; then
    echo "    airdrop rejected (rate-limited or faucet down); checking balance" >&2
  fi
  BALANCE_LAMPORTS=$(solana balance --lamports | awk '{print $1}')
  echo "    balance post-airdrop: ${BALANCE_LAMPORTS} lamports"
  if [[ "${BALANCE_LAMPORTS}" -lt "${MIN_BALANCE_LAMPORTS}" ]]; then
    echo "FATAL: balance ${BALANCE_LAMPORTS} below required ${MIN_BALANCE_LAMPORTS}. Retry later or fund manually via https://faucet.solana.com." >&2
    exit 5
  fi
fi

# ---------------------------------------------------------------------------
# 4. solana program deploy
# ---------------------------------------------------------------------------
if [[ ! -f "${PROGRAM_KEYPAIR}" ]]; then
  echo "FATAL: program keypair ${PROGRAM_KEYPAIR} missing — cargo build-sbf was expected to create it." >&2
  exit 1
fi
PROGRAM_ID=$(solana-keygen pubkey "${PROGRAM_KEYPAIR}")

echo "==> solana program deploy"
echo "    program id : ${PROGRAM_ID}"
echo "    artifact   : ${ARTIFACT}"
solana program deploy \
  --url "${CLUSTER_URL}" \
  --keypair "${DEPLOYER_KEYPAIR}" \
  --program-id "${PROGRAM_KEYPAIR}" \
  "${ARTIFACT}"

# `solana program show` confirms the deploy landed by reading the account
# back from the cluster. A non-zero exit here means the on-chain state
# does not match the keypair we deployed against — bail loudly.
echo "==> Verifying deploy"
if ! solana program show --url "${CLUSTER_URL}" "${PROGRAM_ID}" >/dev/null; then
  echo "FATAL: solana program show ${PROGRAM_ID} failed post-deploy." >&2
  exit 6
fi
echo "    program ${PROGRAM_ID} confirmed deployed on ${CLUSTER}"

# ---------------------------------------------------------------------------
# 5. Persist Program ID in zettapay_protocol_config
# ---------------------------------------------------------------------------
if [[ "${SKIP_PERSIST:-0}" == "1" ]]; then
  echo "==> SKIP_PERSIST=1 — leaving zettapay_protocol_config untouched"
else
  echo "==> Persisting Program ID in zettapay_protocol_config"
  npx --yes tsx scripts/persist-program-id.ts \
    --program-name "${PROGRAM_NAME}" \
    --cluster "${CLUSTER}" \
    --program-id "${PROGRAM_ID}" \
    --deployer "${DEPLOYER_PUBKEY}" \
    --sha256 "${SHA256}" \
    --size "${SIZE_BYTES}"
fi

echo
echo "==> Done"
echo "    program id : ${PROGRAM_ID}"
echo "    cluster    : ${CLUSTER}"
echo "    artifact   : ${ARTIFACT} (${SIZE_BYTES} bytes, sha256 ${SHA256})"
echo
echo "Smoke-test the live program with:"
echo "    ZETTAPAY_PROGRAM_ID=${PROGRAM_ID} SOLANA_KEYPAIR_PATH=${DEPLOYER_KEYPAIR} npm run smoke:devnet"
