#!/usr/bin/env node
// CLI: expand a free-form INTENT into a validated mission spec, insert it,
// and (optionally) dispatch it.
//
// Usage:
//   node fabric/bin/intent-to-mission.js \
//     --workspace-slug zettapay \
//     --intent "Merchant deve poder receber pagamento BTC P2P de qualquer wallet..." \
//     [--context "additional context"] \
//     [--dispatch-url https://fabric.internal/execute-mission]
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY required.

'use strict';

const { makeSb } = require('../lib/sb');
const { intentToMission } = require('../lib/intent');

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args['workspace-slug'] || !args.intent) {
    process.stderr.write('usage: --workspace-slug <slug> --intent <text> [--context <text>] [--dispatch-url <url>]\n');
    process.exit(64);
  }

  const sb = makeSb({
    url: process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  const dispatch = args['dispatch-url']
    ? async (mission) => {
        const res = await fetch(args['dispatch-url'], {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ mission_id: mission.id }),
        });
        if (!res.ok) throw new Error('dispatch_failed_' + res.status);
      }
    : null;

  const result = await intentToMission(
    { workspace_slug: args['workspace-slug'], intent: args.intent, context: args.context },
    { sb, dispatch }
  );
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write('[intent-to-mission] ' + err.message + '\n');
  process.exit(2);
});
