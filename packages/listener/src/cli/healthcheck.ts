// `zettapay-listener healthcheck` — GET the local health server and print a
// human-readable status. Exits 0 if the listener reports healthy, 1 otherwise.
// Designed for systemd ExecStartPost / docker HEALTHCHECK style usage.

import { c, flagBool, flagString, parseFlags, readEnvFile } from './util.js';
import * as path from 'node:path';

export interface HealthOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

interface HealthPayload {
  ok?: boolean;
  ws_connected?: boolean;
  subscribed_count?: number;
  last_event_at?: string | null;
  last_block_height?: number | null;
  uptime_s?: number;
  // Allow arbitrary extra fields without breaking on schema drift.
  [extra: string]: unknown;
}

function helpText(): string {
  return [
    `${c.bold('zettapay-listener healthcheck')} — probe the local health server`,
    '',
    '  --port <n>       Override HEALTH_PORT from .env / env',
    '  --host <h>       Override host (default 127.0.0.1)',
    '  --json           Emit raw JSON instead of human output',
    '  --timeout <ms>   Default 3000',
    '',
  ].join('\n');
}

export async function runHealthcheck(
  argv: readonly string[],
  opts: HealthOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help')) {
    process.stdout.write(helpText());
    return 0;
  }
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const envFile = await readEnvFile(path.join(cwd, '.env'));

  const port = Number.parseInt(
    flagString(flags, 'port') ?? env.HEALTH_PORT ?? envFile?.HEALTH_PORT ?? '8787',
    10,
  );
  const host = flagString(flags, 'host') ?? '127.0.0.1';
  const timeoutMs = Number.parseInt(flagString(flags, 'timeout') ?? '3000', 10);
  const url = `http://${host}:${port}/health`;
  const f = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await f(url, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    const msg = (err as Error).message;
    if (flagBool(flags, 'json')) {
      process.stdout.write(JSON.stringify({ ok: false, error: msg, url }) + '\n');
    } else {
      process.stdout.write(c.red(`✗ unreachable at ${url} — ${msg}`) + '\n');
      process.stdout.write(
        c.dim('  Is the listener running? `zettapay-listener start`') + '\n',
      );
    }
    return 1;
  }
  clearTimeout(timer);

  let body: HealthPayload = {};
  try {
    body = (await resp.json()) as HealthPayload;
  } catch {
    body = {};
  }

  const healthy = resp.status === 200 && body.ok === true;

  if (flagBool(flags, 'json')) {
    process.stdout.write(
      JSON.stringify({ ok: healthy, http_status: resp.status, body, url }) + '\n',
    );
    return healthy ? 0 : 1;
  }

  const mark = healthy ? c.green('✓') : c.red('✗');
  const tag = healthy ? c.green('healthy') : c.yellow('degraded');
  process.stdout.write(`${mark} ${url} → HTTP ${resp.status} (${tag})\n`);
  if (body.ws_connected !== undefined) {
    const wsTag = body.ws_connected ? c.green('connected') : c.yellow('disconnected');
    process.stdout.write(`  mempool.space WebSocket: ${wsTag}\n`);
  }
  if (body.subscribed_count !== undefined) {
    process.stdout.write(
      `  watched addresses: ${c.cyan(String(body.subscribed_count))}\n`,
    );
  }
  if (body.last_event_at !== undefined) {
    const v = body.last_event_at ?? c.dim('none yet');
    process.stdout.write(`  last event: ${v}\n`);
  }
  if (body.last_block_height !== undefined && body.last_block_height !== null) {
    process.stdout.write(`  last block: ${c.cyan(String(body.last_block_height))}\n`);
  }
  if (body.uptime_s !== undefined) {
    process.stdout.write(`  uptime: ${c.cyan(`${body.uptime_s}s`)}\n`);
  }
  return healthy ? 0 : 1;
}

export { helpText as healthcheckHelp };
