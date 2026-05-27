#!/usr/bin/env node
// `zettapay-receiver` CLI entrypoint. Mirrors the structure of the
// listener's main: top-level help/version handled before any subcommand,
// then dispatch. `listen` is the default subcommand so `zettapay-receiver`
// alone behaves how a tester expects.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { c } from './util.js';
import { runListen } from './listen.js';

export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    /* ignore — fall back to env var injected by npm */
  }
  return process.env.npm_package_version ?? '0.0.0';
}

function topLevelHelp(version: string): string {
  return [
    `${c.bold('zettapay-receiver')} ${c.dim('v' + version)} — webhook receiver test tool`,
    '',
    'Usage: zettapay-receiver <command> [flags]',
    '',
    'Commands:',
    `  ${c.cyan('listen')}   bind a local HTTP server, verify HMAC, log payloads (default)`,
    '',
    'Run `zettapay-receiver listen --help` for listen flags.',
    'Run `zettapay-receiver --version` to print the installed version.',
    '',
  ].join('\n');
}

export async function dispatch(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const version = packageVersion();

  if (sub === '--help' || sub === '-h' || sub === 'help' || sub === undefined) {
    // Default with no args → show help. Booting a server with no `--secret`
    // would just error out anyway; surfacing the help text is friendlier.
    process.stdout.write(topLevelHelp(version));
    return 0;
  }
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    process.stdout.write(`zettapay-receiver ${version}\n`);
    return 0;
  }

  switch (sub) {
    case 'listen':
      return await runListen(rest);
    default:
      process.stderr.write(c.red(`unknown command "${sub}"`) + '\n\n' + topLevelHelp(version));
      return 2;
  }
}

/**
 * Mirror of the listener's `invokedAsScript` heuristic: realpath check first
 * (handles `npm i -g` symlinks) with conservative suffix fallbacks for
 * bundled or unusual invocations.
 */
function invokedAsScript(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const myFile = fileURLToPath(import.meta.url);
  if (argv1 === myFile) return true;
  try {
    if (realpathSync(argv1) === myFile) return true;
  } catch {
    /* argv1 not a real path */
  }
  return (
    argv1.endsWith(`${path.sep}main.js`) ||
    argv1.endsWith('/main.js') ||
    argv1.endsWith('\\main.js') ||
    argv1.endsWith(`${path.sep}zettapay-receiver`) ||
    argv1.endsWith('/zettapay-receiver') ||
    argv1.endsWith('\\zettapay-receiver')
  );
}

if (invokedAsScript()) {
  dispatch(process.argv.slice(2)).then(
    (code) => {
      // The `listen` path holds the loop open via the HTTP server; if the
      // user hit Ctrl+C the shutdown handler already cleared the server,
      // so the loop drains on its own. We only force exit on non-zero
      // codes so any error output flushes synchronously.
      process.exitCode = code;
      if (code !== 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`zettapay-receiver fatal: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
