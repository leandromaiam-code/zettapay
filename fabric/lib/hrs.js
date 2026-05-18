// Load HR-* rules for a workspace from fabric_layer0_premissas.

'use strict';

async function loadWorkspaceHrs(sb, workspaceId) {
  const path =
    '/rest/v1/fabric_layer0_premissas' +
    '?workspace_id=eq.' + encodeURIComponent(workspaceId) +
    '&premissa_kind=eq.HR' +
    '&select=id,title,body,severity,detection_patterns,allowlist_paths';
  const rows = await sb('GET', path);
  return Array.isArray(rows) ? rows : [];
}

function compilePatterns(rule) {
  const pats = Array.isArray(rule.detection_patterns) ? rule.detection_patterns : [];
  return pats
    .map((p) => {
      try {
        return new RegExp(p, 'i');
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

module.exports = { loadWorkspaceHrs, compilePatterns };
