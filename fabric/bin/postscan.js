#!/usr/bin/env node
// Post-merge cron: scans commits merged into main since the last run, runs HR
// regex detection on the added lines, and opens an auto-revert PR for any
// commit containing a hard/blocker violation.
//
// Designed to run as fabric-hr-postscan.timer (hourly).
//
// Usage:
//   node fabric/bin/postscan.js [--repo-path /opt/fabric-workspaces/zettapay] \
//                               [--workspace-slug zettapay] \
//                               [--since-file /var/lib/fabric/hr-postscan.lastsha] \
//                               [--dry-run]
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GH_TOKEN (for `gh pr create`).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { makeSb } = require('../lib/sb');
const { loadWorkspaceHrs } = require('../lib/hrs');
const { compileRule, isAllowlisted, checkLine } = require('../lib/scan');
const { appendAudit } = require('../lib/audit');

function parseArgs(argv) {
  const out = { dryRun: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a.startsWith('--')) out[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
  }
  return out;
}

function runGit(cwd, args) {
  return execSync('git ' + args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function readSince(file, fallback) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || fallback;
  } catch {
    return fallback;
  }
}

function writeSince(file, sha) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, sha + '\n');
  } catch (err) {
    process.stderr.write('[postscan] could not persist last sha: ' + err.message + '\n');
  }
}

function listCommitsSince(cwd, since) {
  const out = runGit(cwd, 'log --no-merges --format=%H ' + since + '..HEAD');
  return out.split('\n').filter(Boolean);
}

function scanCommit(cwd, sha, compiled) {
  const diff = runGit(cwd, 'show --no-color --unified=0 --format= ' + sha);
  const violations = [];
  let file = null;
  let cursor = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      file = null;
      cursor = 0;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const m = raw.match(/^\+\+\+ (?:b\/)?(.+)$/);
      file = m && m[1] !== '/dev/null' ? m[1] : null;
      continue;
    }
    if (raw.startsWith('@@')) {
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) cursor = parseInt(m[1], 10);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      const text = raw.slice(1);
      if (!isAllowlisted(file)) {
        for (const hit of checkLine(text, compiled)) {
          violations.push({
            file,
            line: cursor,
            rule_id: hit.rule.id,
            severity: hit.rule.severity,
            pattern: hit.pattern,
            snippet: text.trim().slice(0, 160),
          });
        }
      }
      cursor++;
    } else if (raw.startsWith(' ')) {
      cursor++;
    }
  }
  return violations;
}

function openRevertPr({ cwd, sha, violations, dryRun }) {
  const branch = 'auto/hr-revert-' + sha.slice(0, 8);
  const summary = violations
    .map((v) => '- ' + v.rule_id + ' (' + v.severity + ') at ' + v.file + ':' + v.line + ' /' + v.pattern + '/')
    .join('\n');
  const body =
    'Auto-revert filed by fabric-hr-postscan.\n\n' +
    'Commit ' + sha + ' introduced Hard Rule violations:\n\n' + summary +
    '\n\nReview, fix, then re-merge a compliant version.';

  if (dryRun) {
    process.stdout.write('[postscan][DRY] would file revert PR for ' + sha + ' on branch ' + branch + '\n');
    process.stdout.write(body + '\n');
    return { branch, dryRun: true };
  }

  runGit(cwd, 'checkout main');
  runGit(cwd, 'pull --ff-only origin main');
  runGit(cwd, 'checkout -b ' + branch);
  runGit(cwd, 'revert --no-edit ' + sha);
  runGit(cwd, 'push -u origin ' + branch);
  execSync(
    'gh pr create --base main --head ' + branch +
      ' --title "auto-revert: HR violation in ' + sha.slice(0, 8) + '"' +
      ' --body ' + JSON.stringify(body),
    { cwd, stdio: 'inherit' }
  );
  return { branch, dryRun: false };
}

async function main() {
  const args = parseArgs(process.argv);
  const cwd = args.repoPath || '/opt/fabric-workspaces/zettapay';
  const sinceFile = args.sinceFile || '/var/lib/fabric/hr-postscan.lastsha';
  const workspaceSlug = args.workspaceSlug || 'zettapay';

  const sb = makeSb({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });
  const ws = await sb('GET', '/rest/v1/fabric_workspaces?slug=eq.' + encodeURIComponent(workspaceSlug) + '&select=id');
  if (!ws.length) throw new Error('workspace_not_found: ' + workspaceSlug);
  const workspaceId = ws[0].id;

  const rules = await loadWorkspaceHrs(sb, workspaceId);
  const compiled = rules.map(compileRule);

  runGit(cwd, 'fetch --no-tags origin main');
  runGit(cwd, 'checkout main');
  runGit(cwd, 'pull --ff-only origin main');

  const headSha = runGit(cwd, 'rev-parse HEAD').trim();
  const since = readSince(sinceFile, headSha + '~50');
  const commits = listCommitsSince(cwd, since);

  process.stdout.write('[postscan] scanning ' + commits.length + ' commits since ' + since + '\n');

  for (const sha of commits) {
    const violations = scanCommit(cwd, sha, compiled).filter(
      (v) => v.severity === 'hard' || v.severity === 'blocker'
    );
    if (!violations.length) continue;
    process.stdout.write('[postscan] HR hit in ' + sha + ': ' + violations.length + ' violations\n');
    await appendAudit(sb, {
      workspace_id: workspaceId,
      event_type: 'hr_postscan_revert',
      payload: { commit: sha, violations, dry_run: args.dryRun },
    });
    try {
      openRevertPr({ cwd, sha, violations, dryRun: args.dryRun });
    } catch (err) {
      process.stderr.write('[postscan] revert PR failed for ' + sha + ': ' + err.message + '\n');
    }
  }

  if (!args.dryRun) writeSince(sinceFile, headSha);
}

main().catch((err) => {
  process.stderr.write('[postscan] ' + err.message + '\n');
  process.exit(1);
});
