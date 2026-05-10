#!/usr/bin/env bash
# Generates language SDK stubs from the ZettaPay OpenAPI 3.0 spec using
# openapi-generator-cli. The TypeScript SDK in packages/sdk is hand-rolled
# and stays canonical — this script targets the longer tail (python, go,
# rust, php) so contributors can reproduce the same surface area without
# transcribing every endpoint by hand.
#
# Output paths:
#   packages/sdk-python/generated/
#   packages/sdk-go/generated/
#   packages/sdk-rust/generated/
#   packages/sdk-php/generated/
#
# Generated code is intentionally NOT committed by default — the script
# is meant to be run on demand when the spec changes. Vendored hand-tuned
# clients live alongside in the same packages.
#
# Pre-reqs:
#   - Node 18+ (uses npx; openapi-generator-cli ships its own JRE bundle)
#   - The OpenAPI snapshot at docs/api-reference/openapi-3.0.json
#     (run `npm run openapi:export` first if you've changed the spec).

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
spec="${repo_root}/docs/api-reference/openapi-3.0.json"
config_dir="${repo_root}/scripts/openapi-generator"

if [[ ! -f "${spec}" ]]; then
  echo "OpenAPI 3.0 spec not found at ${spec}" >&2
  echo "Run 'npm run openapi:export' first." >&2
  exit 1
fi

# Pin to a stable openapi-generator-cli release. Bump deliberately.
generator_version="7.10.0"
runner=(npx --yes "@openapitools/openapi-generator-cli@2.13.4")

# Tell the wrapper which generator jar to download. Idempotent.
export OPENAPI_GENERATOR_VERSION="${generator_version}"

generate() {
  local lang="$1"
  local generator="$2"
  local out_dir="$3"

  echo "==> ${lang} (generator=${generator}) -> ${out_dir}"
  rm -rf "${out_dir}"
  mkdir -p "${out_dir}"

  local config_file="${config_dir}/${lang}.json"
  local config_arg=()
  if [[ -f "${config_file}" ]]; then
    config_arg=(--config "${config_file}")
  fi

  "${runner[@]}" generate \
    --generator-name "${generator}" \
    --input-spec "${spec}" \
    --output "${out_dir}" \
    --skip-validate-spec \
    "${config_arg[@]}"
}

generate python python "${repo_root}/packages/sdk-python/generated"
generate go     go     "${repo_root}/packages/sdk-go/generated"
generate rust   rust   "${repo_root}/packages/sdk-rust/generated"
generate php    php    "${repo_root}/packages/sdk-php/generated"

echo "==> done. Review diffs against the hand-tuned clients before publishing."
