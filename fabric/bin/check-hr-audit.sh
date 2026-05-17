#!/usr/bin/env bash
# Operator tool — print recent HR-related audit_journal entries for a workspace.
# Intended deployment path: /opt/jarvisai/scripts/check-hr-audit.sh
#
# Usage:
#   check-hr-audit.sh [workspace_slug=zettapay] [limit=20]
#
# Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required.

set -euo pipefail

slug="${1:-zettapay}"
limit="${2:-20}"

: "${SUPABASE_URL:?SUPABASE_URL not set}"
: "${SUPABASE_SERVICE_ROLE_KEY:?SUPABASE_SERVICE_ROLE_KEY not set}"

ws_id=$(curl -fsSL \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  "${SUPABASE_URL}/rest/v1/fabric_workspaces?slug=eq.${slug}&select=id" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r[0]["id"] if r else "")')

if [ -z "$ws_id" ]; then
  echo "workspace_not_found: ${slug}" >&2
  exit 1
fi

curl -fsSL \
  -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
  -H "authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
  "${SUPABASE_URL}/rest/v1/fabric_audit_journal?workspace_id=eq.${ws_id}&event_type=in.(preflight_hr_check,hr_postscan_revert,hr_learning_run)&select=created_at,event_type,payload&order=created_at.desc&limit=${limit}" \
  | python3 -m json.tool
