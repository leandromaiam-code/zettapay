#!/usr/bin/env node
// CLI: preflight a mission spec against the workspace's HR-* rules.
// Usage:
//   node fabric/bin/preflight.js --mission <mission_id>
//   node fabric/bin/preflight.js --workspace-slug zettapay --spec-file <path>
//   echo '{"workspace_id":"...","description":"..."}' | node fabric/bin/preflight.js --stdin
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required.

'use strict';

const fs = require('fs');
const { makeSb } = require('../lib/sb');
const { preflightCheck } = require('../lib/preflight');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdin') out.stdin = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const sb = makeSb({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  let mission;
  if (args.stdin) {
    mission = JSON.parse(await readStdin());
  } else if (args.mission) {
    const rows = await sb('GET', '/rest/v1/fabric_squad_missions?id=eq.' + encodeURIComponent(args.mission) + '&select=*');
    if (!rows.length) throw new Error('mission_not_found: ' + args.mission);
    mission = rows[0];
  } else if (args['workspace-slug'] && args['spec-file']) {
    const ws = await sb('GET', '/rest/v1/fabric_workspaces?slug=eq.' + encodeURIComponent(args['workspace-slug']) + '&select=id');
    if (!ws.length) throw new Error('workspace_not_found: ' + args['workspace-slug']);
    mission = { workspace_id: ws[0].id, description: fs.readFileSync(args['spec-file'], 'utf8') };
  } else {
    process.stderr.write('usage: --mission <id> | --workspace-slug <slug> --spec-file <path> | --stdin\n');
    process.exit(64);
  }

  const result = await preflightCheck(mission, { sb });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write('[preflight] ' + err.message + '\n');
  process.exit(2);
});
