#!/usr/bin/env node
// Entrypoint for the standalone `zettapay-listener` binary. Reads env, wires
// StorageAdapter + BtcListener + WebhookDispatcher + HealthServer, and waits
// for SIGTERM/SIGINT for a graceful shutdown.

import { createStorage } from './storage/index.js';
import { BtcListener, type Logger } from './listener.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { HealthServer, DEFAULT_HEALTH_PORT } from './health-server.js';

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

export async function run(): Promise<void> {
  const cfg = readEnv();
  const storage = createStorage(process.env);

  let merchantId = cfg.merchantId;
  if (!merchantId) {
    const m = await storage.getMerchant('default');
    if (!m) {
      throw new Error(
        '@zettapay/listener: no merchant in storage. Set MERCHANT_ID or run init (Z60).',
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

const argv = process.argv.slice(2);
const subcommand = argv[0];
if (subcommand && subcommand !== 'start') {
  process.stderr.write(
    `@zettapay/listener: unknown command "${subcommand}". Only "start" is implemented in this release.\n` +
      `init/migrate/healthcheck commands ship in Z60.\n`,
  );
  process.exit(2);
}

run().catch((err) => {
  process.stderr.write(`zettapay-listener fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
