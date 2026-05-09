#!/usr/bin/env bash
# Deploy the ZettaPay Anchor program to Solana devnet.
#
# Pre-reqs (host machine, NOT CI — Vercel build path has no Rust toolchain):
#   - solana-cli >= 1.18.26   ($ sh -c "$(curl -sSfL https://release.anza.xyz/v1.18.26/install)")
#   - anchor-cli == 0.30.1    ($ avm install 0.30.1 && avm use 0.30.1)
#   - rustc + cargo nightly stable enough to build Anchor 0.30.1 BPF
#
# What this does
#   1. Pin cluster to devnet and fund the deployer with 2 SOL airdrop
#   2. Build the BPF program -> target/deploy/zettapay.so
#   3. Deploy to the program ID declared in `Anchor.toml` and `lib.rs`
#   4. Initialize the on-chain IDL account so `anchor.idl` queries resolve
#   5. Print the resulting program id + idl account for downstream wiring
#
# Idempotency: re-running an already-deployed program upgrades it via
# `solana program deploy`. The IDL init step uses `anchor idl upgrade` if
# the IDL account already exists.

set -euo pipefail

PROGRAM_NAME="zettapay"
PROGRAM_ID="Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"
CLUSTER_URL="https://api.devnet.solana.com"

echo "==> Selecting devnet cluster"
solana config set --url "${CLUSTER_URL}" >/dev/null
solana config get | sed 's/^/    /'

echo "==> Verifying deployer keypair has SOL"
DEPLOYER=$(solana address)
echo "    deployer: ${DEPLOYER}"
BALANCE_LAMPORTS=$(solana balance --lamports | awk '{print $1}')
if [[ "${BALANCE_LAMPORTS}" -lt 1000000000 ]]; then
  echo "    balance below 1 SOL, requesting airdrop"
  solana airdrop 2 || echo "    airdrop rate-limited; continuing if balance is non-zero"
fi
solana balance | sed 's/^/    /'

echo "==> Building BPF program"
anchor build

echo "==> Deploying to ${CLUSTER_URL}"
anchor deploy --provider.cluster devnet

echo "==> Publishing IDL on-chain (idl init or upgrade)"
if anchor idl init --provider.cluster devnet -f "target/idl/${PROGRAM_NAME}.json" "${PROGRAM_ID}" 2>/dev/null; then
  echo "    idl initialized"
else
  echo "    idl already exists; upgrading"
  anchor idl upgrade --provider.cluster devnet -f "target/idl/${PROGRAM_NAME}.json" "${PROGRAM_ID}"
fi

echo "==> Done"
echo "    program id : ${PROGRAM_ID}"
echo "    idl account: $(solana address -k <(echo unused) 2>/dev/null || echo "see anchor idl fetch ${PROGRAM_ID}")"
echo
echo "Verify from anywhere with:"
echo "    anchor idl fetch --provider.cluster devnet ${PROGRAM_ID}"
