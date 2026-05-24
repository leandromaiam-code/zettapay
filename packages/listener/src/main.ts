#!/usr/bin/env node
// `zettapay-listener` CLI entrypoint. Dispatches to subcommands. The legacy
// behavior (no subcommand → start the watcher) is preserved so existing
// Dockerfile + systemd units keep working.

import { createStorage } from './storage/index.js';
import { BtcListener, type Logger } from './listener.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { HealthServer, DEFAULT_HEALTH_PORT } from './health-server.js';
import { runInit } from './cli/init.js';
import { runHealthcheck } from './cli/healthcheck.js';
import { runVerifyConfig } from './cli/verify-config.js';
import { runMigrate } from './cli/migrate.js';
import { c, parseFlags, flagBool, flagString, readEnvFile } from './cli/util.js';
import * as path from 'node:path';

interface ResolvedConfig {
  merchantId: string;
  webhookUrl: string;
  webhookSecret: string;
  healthPort: number;
  wsUrl?: string;
  restBase?: string;
}

function readEnv(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const errors: string[] = [];
  const webhookUrl = env.MERCHANT_WEBHOOK_URL?.trim();
  if (!webhookUrl) errors.push('MERCHANT_WEBHOOK_URL is required');
  const webhookSecret = env.MERCHANT_WEBHOOK_SECRET?.trim();
  if (!webhookSecret) errors.push('MERCHANT_WEBHOOK_SECRET is required');

  const merchantIdRaw = env.MERCHANT_ID?.trim();
  if (errors.length > 0) {
    throw new Error(
      `@zettapay/listener: missing required env vars:\n  - ${errors.join('\n  - ')}\n` +
        `See @zettapay/listener README for the full env contract.`,
    );
  }

  const portRaw = env.HEALTH_PORT;
  const healthPort = portRaw ? Number.parseInt(portRaw, 10) : DEFAULT_HEALTH_PORT;
  if (!Number.isFinite(healthPort) || healthPort <= 0 || healthPort > 65535) {
    throw new Error(`@zettapay/listener: invalid HEALTH_PORT="${portRaw}"`);
  }

  return {
    merchantId: merchantIdRaw ?? '',
    webhookUrl: webhookUrl!,
    webhookSecret: webhookSecret!,
    healthPort,
    wsUrl: env.MEMPOOL_WS_URL?.trim() || undefined,
    restBase: env.MEMPOOL_REST_URL?.trim() || undefined,
  };
}

const consoleLogger: Logger = {
  info: (msg, meta) => log('info', msg, meta),
  warn: (msg, meta) => log('warn', msg, meta),
  error: (msg, meta) => log('error', msg, meta),
};

function log(level: 'info' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const payload: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    msg,
  };
  if (meta !== undefined) payload.meta = meta instanceof Error ? meta.message : meta;
  const line = JSON.stringify(payload);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/**
 * Hydrate process.env with a `.env` file from cwd if one exists. We do not
 * support shell-style `${VAR}` expansion — intentional, to keep behavior
 * obvious.
 */
async function loadDotEnv(cwd: string): Promise<void> {
  const file = await readEnvFile(path.join(cwd, '.env'));
  if (!file) return;
  for (const [k, v] of Object.entries(file)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export async function run(argv: readonly string[] = []): Promise<void> {
  const { flags } = parseFlags(argv);
  const healthPortOverride = flagString(flags, 'health-port');
  if (healthPortOverride) process.env.HEALTH_PORT = healthPortOverride;
  const logLevel = flagString(flags, 'log-level');
  if (logLevel) process.env.LOG_LEVEL = logLevel;

  const cfg = readEnv();
  const storage = createStorage(process.env);

  let merchantId = cfg.merchantId;
  if (!merchantId) {
    const m = await storage.getMerchant('default');
    if (!m) {
      throw new Error(
        '@zettapay/listener: no merchant in storage. Set MERCHANT_ID or run `zettapay-listener init`.',
      );
    }
    merchantId = m.id;
  }

  const listener = new BtcListener({
    storage,
    merchantId,
    logger: consoleLogger,
    wsUrl: cfg.wsUrl,
    restBase: cfg.restBase,
  });
  const dispatcher = new WebhookDispatcher({
    storage,
    webhookUrl: cfg.webhookUrl,
    webhookSecret: cfg.webhookSecret,
    logger: consoleLogger,
  });
  const health = new HealthServer({
    port: cfg.healthPort,
    statusProvider: () => listener.status(),
    logger: consoleLogger,
  });

  await health.start();
  dispatcher.start();
  await listener.start();

  consoleLogger.info('zettapay_listener.started', {
    merchant_id: merchantId,
    health_port: cfg.healthPort,
    storage: process.env.STORAGE ?? 'json',
  });

  const shutdown = async (signal: string) => {
    consoleLogger.info('zettapay_listener.shutdown', { signal });
    try {
      await listener.stop();
      await dispatcher.stop();
      await health.stop();
      if (storage.close) await storage.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function topLevelHelp(): string {
  return [
    `${c.bold('zettapay-listener')} — self-hosted, non-custodial BTC payment watcher`,
    '',
    'Usage: zettapay-listener <command> [flags]',
    '',
    'Commands:',
    `  ${c.cyan('init')}            interactive setup wizard (.env + merchant.json)`,
    `  ${c.cyan('start')}           run watcher + webhook dispatcher (default)`,
    `  ${c.cyan('healthcheck')}     probe the local health server (exit 0/1)`,
    `  ${c.cyan('verify-config')}   validate .env without starting`,
    `  ${c.cyan('migrate')}         copy storage between adapters`,
    '',
    'Run `zettapay-listener <command> --help` for command flags.',
    '',
  ].join('\n');
}

async function dispatch(argv: readonly string[]): Promise<number> {
  await loadDotEnv(process.cwd());
  const [sub, ...rest] = argv;
  // No subcommand: print help unless --help/--version not asked, OR default to start.
  // We default to `start` so the existing Dockerfile CMD ["start"] / bare
  // invocation both work.
  if (!sub || sub === 'start') {
    if (flagBool(parseFlags(rest).flags, 'help')) {
      process.stdout.write(
        `${c.bold('zettapay-listener start')} — run the watcher\n\n` +
          '  --health-port <n>   Override HEALTH_PORT\n' +
          '  --log-level <lvl>   info | debug | warn | error\n\n',
      );
      return 0;
    }
    await run(rest);
    return 0; // run() never returns under SIGTERM, but tests can mock.
  }
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(topLevelHelp());
    return 0;
  }
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    const v = process.env.npm_package_version ?? '0.1.0';
    process.stdout.write(`zettapay-listener ${v}\n`);
    return 0;
  }
  switch (sub) {
    case 'init':
      return runInit(rest);
    case 'healthcheck':
      return runHealthcheck(rest);
    case 'verify-config':
      return runVerifyConfig(rest);
    case 'migrate':
      return runMigrate(rest);
    default:
      process.stderr.write(
        c.red(`unknown command "${sub}"`) +
          '\n\n' +
          topLevelHelp(),
      );
      return 2;
  }
}

const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('/main.js') === true ||
  process.argv[1]?.endsWith('\\main.js') === true;

if (invokedAsScript) {
  dispatch(process.argv.slice(2)).then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`zettapay-listener fatal: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
