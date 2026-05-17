#!/usr/bin/env node
// Daily HR-learning cron: analyses fabric_audit_journal entries from the last
// 7 days, identifies recurring violation patterns, and proposes new
// detection_patterns via Claude. Suggestions land as severity='soft' new HRs
// for human review (manual upgrade to hard).
//
// Usage:
//   node fabric/bin/hr-learning.js [--workspace-slug zettapay] [--window-days 7] [--dry-run]
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required.

'use strict';

const { makeSb } = require('../lib/sb');
const { invokeClaude, extractJson } = require('../lib/claude');
const { appendAudit } = require('../lib/audit');

function parseArgs(argv) {
  const out = { dryRun: false, windowDays: 7 };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  if (typeof out.windowDays === 'string') out.windowDays = parseInt(out.windowDays, 10);
  return out;
}

async function loadRecentViolations(sb, workspaceId, windowDays) {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString();
  const path =
    '/rest/v1/fabric_audit_journal' +
    '?workspace_id=eq.' + encodeURIComponent(workspaceId) +
    '&event_type=in.(preflight_hr_check,hr_postscan_revert)' +
    '&created_at=gte.' + encodeURIComponent(since) +
    '&select=event_type,payload,created_at' +
    '&order=created_at.desc' +
    '&limit=500';
  const rows = await sb('GET', path);
  return Array.isArray(rows) ? rows : [];
}

function summariseViolations(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const list = row.payload?.violations || [];
    for (const v of list) {
      const key = v.hr_id || v.rule_id || 'unknown';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(v);
    }
  }
  const out = [];
  for (const [hr, list] of buckets) {
    out.push({
      hr_id: hr,
      count: list.length,
      sample_reasons: list.slice(0, 5).map((v) => v.reason || v.snippet || '(no detail)'),
    });
  }
  return out.sort((a, b) => b.count - a.count);
}

function buildLearningPrompt(summary) {
  return [
    'You analyse Hard Rule (HR-*) violations from the last 7 days of the Fabric autodev system.',
    '',
    'Recurring violation summary:',
    JSON.stringify(summary, null, 2),
    '',
    'For any pattern that appears 3+ times and is NOT already covered by an existing detection regex,',
    'propose a NEW soft HR (severity=soft) with:',
    '  - id: a short, kebab-case identifier prefixed by HR-LEARNED-',
    '  - title: <80 chars',
    '  - body: <500 chars rule statement',
    '  - detection_patterns: array of regex strings',
    '',
    'Output JSON only:',
    '{ "proposals": [{ "id": "HR-LEARNED-...", "title": "...", "body": "...", "detection_patterns": [...] }] }',
    'If no proposals warranted, output { "proposals": [] }.',
  ].join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const workspaceSlug = args.workspaceSlug || 'zettapay';

  const sb = makeSb({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const ws = await sb('GET', '/rest/v1/fabric_workspaces?slug=eq.' + encodeURIComponent(workspaceSlug) + '&select=id');
  if (!ws.length) throw new Error('workspace_not_found: ' + workspaceSlug);
  const workspaceId = ws[0].id;

  const rows = await loadRecentViolations(sb, workspaceId, args.windowDays);
  if (!rows.length) {
    process.stdout.write('[hr-learning] no violations in window — nothing to learn\n');
    return;
  }

  const summary = summariseViolations(rows);
  process.stdout.write('[hr-learning] violation summary: ' + JSON.stringify(summary, null, 2) + '\n');

  const prompt = buildLearningPrompt(summary);
  let stdout;
  try {
    stdout = await invokeClaude(prompt, { effort: 'high' });
  } catch (err) {
    process.stderr.write('[hr-learning] claude invoke failed: ' + err.message + '\n');
    return;
  }
  const parsed = extractJson(stdout);
  const proposals = parsed?.proposals || [];
  process.stdout.write('[hr-learning] ' + proposals.length + ' proposal(s) generated\n');

  for (const p of proposals) {
    const row = {
      id: workspaceSlug + ':' + p.id,
      workspace_id: workspaceId,
      premissa_kind: 'HR',
      severity: 'soft',
      title: p.title || p.id,
      body: p.body || '',
      detection_patterns: Array.isArray(p.detection_patterns) ? p.detection_patterns : [],
    };
    if (args.dryRun) {
      process.stdout.write('[hr-learning][DRY] would insert: ' + JSON.stringify(row) + '\n');
      continue;
    }
    try {
      await sb('POST', '/rest/v1/fabric_layer0_premissas?on_conflict=id', row);
    } catch (err) {
      process.stderr.write('[hr-learning] insert failed for ' + row.id + ': ' + err.message + '\n');
    }
  }

  await appendAudit(sb, {
    workspace_id: workspaceId,
    event_type: 'hr_learning_run',
    payload: { window_days: args.windowDays, proposals, summary },
  });
}

main().catch((err) => {
  process.stderr.write('[hr-learning] ' + err.message + '\n');
  process.exit(1);
});
