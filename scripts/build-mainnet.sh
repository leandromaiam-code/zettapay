#!/usr/bin/env bash
# Build the ZettaPay Anchor program for Solana mainnet-beta (Z29.1).
#
# Output: target/deploy/zettapay.so (+ sha256 + size).
# This script does NOT deploy. It only produces the verifiable bytecode.
# See scripts/deploy-mainnet.sh for the actual deploy step (human-signed
# with Phantom or hardware wallet — Fabric never holds mainnet keys).
#
# Pre-reqs (host machine, not Vercel CI):
#   - solana-cli >= 1.18.26   ($ sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)")
#   - anchor-cli == 0.30.1    ($ avm install 0.30.1 && avm use 0.30.1)
#
# Idempotency: re-running rebuilds .so. Honors `MAINNET_PROGRAM_ID` env
# override (used by deploy-mainnet.sh when Leandro registers a fresh mainnet
# program ID separate from the devnet placeholder).

set -euo pipefail

PROGRAM_NAME="zettapay"
ARTIFACT_DIR="target/deploy"
ARTIFACT="${ARTIFACT_DIR}/${PROGRAM_NAME}.so"
IDL_ARTIFACT="target/idl/${PROGRAM_NAME}.json"

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

if ! command -v anchor >/dev/null 2>&1; then
  echo "FATAL: anchor-cli not installed. See header comment for setup." >&2
  exit 127
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "FATAL: cargo not installed. Install Rust + solana-cli first." >&2
  exit 127
fi

ANCHOR_VERSION="$(anchor --version 2>/dev/null | awk '{print $2}')"
SOLANA_VERSION="$(solana --version 2>/dev/null | awk '{print $2}')"
RUSTC_VERSION="$(rustc --version 2>/dev/null | awk '{print $2}')"

echo "==> Toolchain"
echo "    anchor : ${ANCHOR_VERSION}"
echo "    solana : ${SOLANA_VERSION}"
echo "    rustc  : ${RUSTC_VERSION}"

if [[ -n "${MAINNET_PROGRAM_ID:-}" ]]; then
  echo "==> Building with MAINNET_PROGRAM_ID=${MAINNET_PROGRAM_ID}"
  echo "    (sed-injecting declare_id! into lib.rs is destructive; instead"
  echo "     pass --program-id via anchor build to override only the .so)"
fi

echo "==> anchor build (release / BPF)"
# anchor build uses cargo build-sbf under the hood and produces a release
# artifact by default — the optimizations live in `[profile.release]` of
# the workspace Cargo.toml (lto=fat, codegen-units=1, overflow-checks=on).
anchor build

if [[ ! -f "${ARTIFACT}" ]]; then
  echo "FATAL: expected artifact ${ARTIFACT} not produced." >&2
  exit 1
fi
if [[ ! -f "${IDL_ARTIFACT}" ]]; then
  echo "FATAL: expected IDL ${IDL_ARTIFACT} not produced." >&2
  exit 1
fi

SIZE_BYTES=$(wc -c < "${ARTIFACT}" | tr -d ' ')
SHA256=$(sha256sum "${ARTIFACT}" | awk '{print $1}')

cat > "${ARTIFACT_DIR}/${PROGRAM_NAME}.mainnet.json" <<EOF
{
  "program": "${PROGRAM_NAME}",
  "artifact": "${ARTIFACT}",
  "idl": "${IDL_ARTIFACT}",
  "size_bytes": ${SIZE_BYTES},
  "sha256": "${SHA256}",
  "toolchain": {
    "anchor": "${ANCHOR_VERSION}",
    "solana": "${SOLANA_VERSION}",
    "rustc": "${RUSTC_VERSION}"
  },
  "built_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "git_sha": "$(git rev-parse HEAD 2>/dev/null || echo unknown)"
}
EOF

echo "==> Artifact ready"
echo "    path   : ${ARTIFACT}"
echo "    size   : ${SIZE_BYTES} bytes"
echo "    sha256 : ${SHA256}"
echo "    meta   : ${ARTIFACT_DIR}/${PROGRAM_NAME}.mainnet.json"
echo
echo "Next: review the artifact, then sign-and-deploy with:"
echo "    MAINNET_DEPLOYER_KEYPAIR=/path/to/keypair.json bash scripts/deploy-mainnet.sh"
