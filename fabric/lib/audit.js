// Append entries to fabric_audit_journal. Best-effort: never throws.

'use strict';

async function appendAudit(sb, { workspace_id, event_type, payload }) {
  try {
    await sb('POST', '/rest/v1/fabric_audit_journal', {
      workspace_id,
      event_type,
      payload: payload || {},
    });
  } catch (err) {
    process.stderr.write('[audit] write failed (' + event_type + '): ' + err.message + '\n');
  }
}

module.exports = { appendAudit };
