// `zettapay-receiver listen` subcommand. Boots a ReceiverServer, renders
// every webhook either as JSON-lines (default — easy to pipe to jq, easy
// for CI to grep) or as a human-readable box (`--pretty` — easy to eyeball
// during a hand-run integration test).
//
// The "graceful shutdown" path matters because dev workflows tend to be
// `Ctrl+C` heavy: we must close the listening socket cleanly so the port is
// free for the next `npm run dev` cycle.

import { appendFileSync } from 'node:fs';
import { ReceiverServer, type ReceiverLogger, type WebhookOutcome } from '../server.js';
import { c, flagBool, flagInt, flagString, parseFlags } from './util.js';

export interface ListenRunOptions {
  /** Override stdout writer — used by tests. */
  stdout?: (line: string) => void;
  /** Override stderr writer — used by tests. */
  stderr?: (line: string) => void;
}

export function listenHelp(): string {
  return [
    `${c.bold('zettapay-receiver listen')} — verify webhook deliveries locally`,
    '',
    'Usage:',
    '  zettapay-receiver listen --secret whsec_xxx [--port 9876] [--bind 127.0.0.1] [--pretty]',
    '',
    'Required:',
    '  --secret <whsec_...>   HMAC secret (matches MERCHANT_WEBHOOK_SECRET).',
    '',
    'Optional:',
    '  --port <n>             Bind port (default 9876).',
    '  --bind <host>          Bind host (default 127.0.0.1).',
    '                         Use 0.0.0.0 only on a trusted network.',
    '  --max-age <seconds>    Replay window (default 300).',
    '  --pretty               Human-readable box per request.',
    '  --log-file <path>      Append JSON-line logs to a file (alongside stdout).',
    '  --exit-on <n>          Exit after N successful webhooks (CI-friendly).',
    '  --help                 Show this help.',
    '',
  ].join('\n');
}

export async function runListen(
  argv: readonly string[],
  opts: ListenRunOptions = {},
): Promise<number> {
  const stdoutWrite = opts.stdout ?? ((line: string) => process.stdout.write(line));
  const stderrWrite = opts.stderr ?? ((line: string) => process.stderr.write(line));
  const { flags } = parseFlags(argv);

  if (flagBool(flags, 'help')) {
    stdoutWrite(listenHelp());
    return 0;
  }

  const secret = flagString(flags, 'secret') ?? process.env.WEBHOOK_SECRET;
  if (!secret) {
    stderrWrite(
      c.red('error: --secret is required') +
        ' (or set WEBHOOK_SECRET in the environment)\n\n' +
        listenHelp(),
    );
    return 2;
  }

  const port = flagInt(flags, 'port') ?? 9876;
  const bind = flagString(flags, 'bind') ?? '127.0.0.1';
  const maxAge = flagInt(flags, 'max-age') ?? 300;
  const pretty = flagBool(flags, 'pretty');
  const logFile = flagString(flags, 'log-file');
  const exitOn = flagInt(flags, 'exit-on');

  const fileLogger = logFile
    ? (level: string, msg: string, meta?: unknown) => {
        try {
          appendFileSync(
            logFile,
            JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(meta === undefined ? {} : { meta }) }) +
              '\n',
          );
        } catch {
          /* log file rotated / permissions changed — best-effort */
        }
      }
    : null;

  const log: ReceiverLogger = {
    info: (msg, meta) => {
      if (!pretty) stdoutWrite(jsonLine('info', msg, meta));
      fileLogger?.('info', msg, meta);
    },
    warn: (msg, meta) => {
      if (!pretty) stdoutWrite(jsonLine('warn', msg, meta));
      fileLogger?.('warn', msg, meta);
    },
    error: (msg, meta) => {
      stderrWrite(jsonLine('error', msg, meta));
      fileLogger?.('error', msg, meta);
    },
  };

  let okCount = 0;
  let shuttingDown = false;
  let server: ReceiverServer | null = null;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('receiver.shutdown', { reason });
    try {
      await server?.close();
    } catch (err) {
      log.error('receiver.shutdown_failed', { message: (err as Error).message });
    }
  };

  server = new ReceiverServer({
    secret,
    bind,
    port,
    maxAgeSeconds: maxAge,
    log,
    onWebhook: (outcome) => {
      if (pretty) stdoutWrite(renderPretty(outcome) + '\n');
      if (outcome.ok) okCount += 1;
      if (exitOn != null && okCount >= exitOn) {
        void shutdown('exit-on').then(() => {
          process.exitCode = 0;
        });
      }
    },
  });

  const bound = await server.listen();
  stdoutWrite(
    c.cyan('zettapay-receiver') +
      ` listening on ${c.bold(`http://${bound.host}:${bound.port}`)} ` +
      c.dim(`(POST /webhook, GET /)`) +
      '\n',
  );
  if (bind === '0.0.0.0') {
    stderrWrite(
      c.yellow(
        'warning: bound to 0.0.0.0 — receiver accepts requests from any network interface. ' +
          'Only do this on a trusted network.',
      ) + '\n',
    );
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await new Promise<void>((resolve) => {
    const tick = (): void => {
      if (shuttingDown) resolve();
      else setTimeout(tick, 200);
    };
    tick();
  });

  return 0;
}

function jsonLine(level: string, msg: string, meta?: unknown): string {
  return (
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...(meta === undefined ? {} : { meta }),
    }) + '\n'
  );
}

/**
 * Render a webhook outcome as a fixed-width box. Width is fixed at 70 to keep
 * everything visible on an 80-column terminal without word-wrapping the
 * separator border.
 */
function renderPretty(o: WebhookOutcome): string {
  const W = 70;
  const ts = o.receivedAt.toISOString();
  const head = `POST /webhook  ${ts}`;
  const lines: string[] = [];
  lines.push('+-- ' + head + ' ' + '-'.repeat(Math.max(0, W - head.length - 6)) + '+');
  if (o.ok) {
    const age = o.ageMs != null ? `${(o.ageMs / 1000).toFixed(1)}s` : 'n/a';
    lines.push(boxLine('signature', c.green(`ok (valid HMAC, age ${age})`), W));
  } else {
    lines.push(boxLine('signature', c.red(`FAILED — ${o.reason}`), W));
  }

  const env = o.envelope ?? {};
  if (env.event) lines.push(boxLine('event', String(env.event), W));
  if (env.invoice_id) lines.push(boxLine('invoice', String(env.invoice_id), W));
  if (env.chain) lines.push(boxLine('chain', String(env.chain), W));

  const data = (env.data ?? {}) as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      lines.push(boxLine(k, String(v), W));
    }
  }

  lines.push('+' + '-'.repeat(W - 2) + '+');
  return lines.join('\n');
}

/**
 * Build a `| label: value |` row. Padding accounts for ANSI escape codes by
 * stripping them when measuring length, so colored values don't break the
 * border alignment.
 */
function boxLine(label: string, value: string, width: number): string {
  const left = `| ${label}:`;
  const inner = width - left.length - 2; // 2 for trailing " |"
  const visibleLen = stripAnsi(value).length;
  const valuePadded = value + ' '.repeat(Math.max(0, inner - visibleLen - 1));
  return `${left} ${valuePadded}|`;
}

function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
