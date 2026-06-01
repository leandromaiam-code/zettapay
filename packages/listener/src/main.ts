#!/usr/bin/env node
// `zettapay-listener` CLI entrypoint. Dispatches to subcommands. The legacy
// behavior (no subcommand → start the watcher) is preserved so existing
// Dockerfile + systemd units keep working.

import { createStorage } from './storage/index.js';
import { BtcListener, type Logger } from './listener.js';
import { BaseWatcher } from './base-watcher.js';
import {
  FixedAddressWatcher,
  parseFixedChains,
  parseEvmTokens,
  EVM_CHAIN_REGISTRY,
  type FixedChainConfig,
} from './fixed-address-watcher.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';
import { DEFAULT_HEALTH_PORT } from './health-server.js';
import { AppServer } from './http-server.js';
import { resolveRpcUrls } from './rpc-quorum.js';
import { parseRateLimitEnv } from './rate-limit.js';
import { runInit } from './cli/init.js';
import { runHealthcheck } from './cli/healthcheck.js';
import { runVerifyConfig } from './cli/verify-config.js';
import { runMigrate } from './cli/migrate.js';
import { runDeriveAddress } from './cli/derive-address.js';
import { runCreateInvoice } from './cli/create-invoice.js';
import { c, parseFlags, flagBool, flagString, readEnvFile } from './cli/util.js';
import { getNetworkConfig, readNetwork, type Network } from './network.js';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

interface ResolvedConfig {
  merchantId: string;
  webhookUrl: string;
  webhookSecret: string;
  healthPort: number;
  network: Network;
  wsUrl: string;
  restBase: string;
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

  const network = readNetwork(env);
  const profile = getNetworkConfig(network, env);

  return {
    merchantId: merchantIdRaw ?? '',
    webhookUrl: webhookUrl!,
    webhookSecret: webhookSecret!,
    healthPort,
    network,
    wsUrl: env.MEMPOOL_WS_URL?.trim() || profile.ws,
    restBase: env.MEMPOOL_REST_URL?.trim() || profile.rest,
  };
}

/**
 * Production safety guard (Z76 FIX 4). In production an unauthenticated POST
 * /invoice lets anyone mint invoices / exhaust the nonce pool, so a missing
 * ZETTAPAY_API_KEY must HALT the boot with a clear error rather than silently
 * running open (the old behavior only logged a "DEV MODE" warning). In any
 * non-production env the key stays optional — returns a warning string the
 * caller may log, or null when nothing to warn about. Throws only in prod.
 */
export function assertApiKeyForEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const isProd = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const hasKey = Boolean(env.ZETTAPAY_API_KEY?.trim());
  if (hasKey) return null;
  if (isProd) {
    throw new Error(
      '@zettapay/listener: NODE_ENV=production but ZETTAPAY_API_KEY is not set. ' +
        'POST /invoice would be unauthenticated — refusing to start. ' +
        'Set ZETTAPAY_API_KEY (any high-entropy secret) or run with NODE_ENV unset for local dev.',
    );
  }
  return 'DEV MODE: ZETTAPAY_API_KEY is unset — POST /invoice is unauthenticated. Set it for production.';
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

/**
 * Resolve our own package.json version once. Used by `--version` and the
 * banner. Falls back to '0.0.0' if the file isn't readable (e.g., bundled).
 */
export function packageVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', 'package.json');
    const raw = readFileSync(pkgPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: string };
    if (parsed.version) return parsed.version;
  } catch {
    /* ignore */
  }
  return process.env.npm_package_version ?? '0.0.0';
}

export async function run(argv: readonly string[] = []): Promise<void> {
  const { flags } = parseFlags(argv);
  const healthPortOverride = flagString(flags, 'health-port');
  if (healthPortOverride) process.env.HEALTH_PORT = healthPortOverride;
  const logLevel = flagString(flags, 'log-level');
  if (logLevel) process.env.LOG_LEVEL = logLevel;

  const cfg = readEnv();
  // Prod-guard (FIX 4): refuse to boot a production deployment whose POST
  // /invoice would be unauthenticated. In dev this only returns a warning.
  const apiKeyWarning = assertApiKeyForEnv(process.env);
  if (apiKeyWarning) consoleLogger.warn('http_server.no_api_key', { message: apiKeyWarning });

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
  // USDC on Base is opt-in: only when MERCHANT_XPUB_EVM is set does the base
  // chain become reachable (HTTP route + watcher). A BTC-only deployment runs
  // identically to before — no EVM xpub, no BaseWatcher, base route rejected.
  const evmXpub = process.env.MERCHANT_XPUB_EVM?.trim() || undefined;
  const baseRpcUrl = process.env.BASE_RPC_URL?.trim() || undefined;

  // Fixed-address (xpub-less) USDC mode (Z74) — opt-in via MERCHANT_EVM_ADDRESS.
  // Independent of xpub mode; if both target the same chain, xpub wins (more
  // secure) and the fixed watcher skips that chain with a warning.
  const fixedAddress = process.env.MERCHANT_EVM_ADDRESS?.trim() || undefined;
  const fixedChainSpecs = fixedAddress
    ? parseFixedChains(process.env.MERCHANT_EVM_CHAINS)
    : [];
  // Tokens the merchant accepts on the fixed address (Z77). Defaults to USDC.
  // 'usdt' is only realized on chains that list it (Base); on a USDC-only chain
  // the intersection collapses back to USDC.
  const enabledTokenAliases = parseEvmTokens(process.env.MERCHANT_EVM_TOKENS);
  const fixedChains: FixedChainConfig[] = [];
  for (const spec of fixedChainSpecs) {
    if (spec.chain === 'base' && evmXpub) {
      consoleLogger.warn('fixed_watcher.xpub_precedence', {
        chain: 'base',
        message: 'MERCHANT_XPUB_EVM and MERCHANT_EVM_ADDRESS both set for base — xpub mode wins',
      });
      continue;
    }
    // RPC quorum (FIX 2): resolve the full endpoint list — a merchant override
    // (csv in the chain's env var) replaces the public defaults; otherwise the
    // 2-3 bundled public endpoints are cross-checked. DEFAULT_RPC_URLS is keyed
    // by the registry ALIAS ('ethereum'), not the canonical chain id ('eth').
    const alias =
      Object.keys(EVM_CHAIN_REGISTRY).find(
        (k) => EVM_CHAIN_REGISTRY[k]!.chain === spec.chain,
      ) ?? spec.chain;
    const rpcUrls = resolveRpcUrls(alias, process.env[spec.rpcEnvVar]?.trim());
    const rpcUrl = rpcUrls[0] ?? spec.defaultRpcUrl;
    const enabledTokens = spec.tokens.filter((t) =>
      enabledTokenAliases.includes(t.symbol),
    );
    fixedChains.push({
      ...spec,
      rpcUrl,
      rpcUrls: rpcUrls.length > 0 ? rpcUrls : [rpcUrl],
      enabledTokens: enabledTokens.length > 0 ? enabledTokens : spec.tokens.slice(0, 1),
    });
  }

  const apiServer = new AppServer({
    port: cfg.healthPort,
    statusProvider: () => listener.status(),
    storage,
    merchantId,
    apiKey: process.env.ZETTAPAY_API_KEY?.trim() || undefined,
    corsOrigins: (process.env.MERCHANT_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
    evmXpub,
    fixedEvmAddress: fixedAddress,
    fixedEvmChains: fixedChains.map((ch) => ch.chain),
    fixedEvmTokens: enabledTokenAliases.map((t) => t.toLowerCase()),
    rateLimit: parseRateLimitEnv(process.env.ZETTAPAY_RATE_LIMIT),
    logger: consoleLogger,
  });

  const baseWatcher = evmXpub
    ? new BaseWatcher({
        storage,
        merchantId,
        rpcUrl: baseRpcUrl,
        logger: consoleLogger,
      })
    : null;

  const fixedWatcher =
    fixedAddress && fixedChains.length > 0
      ? new FixedAddressWatcher({
          storage,
          merchantId,
          address: fixedAddress,
          chains: fixedChains,
          logger: consoleLogger,
        })
      : null;

  await apiServer.start();
  dispatcher.start();
  await listener.start();
  if (baseWatcher) await baseWatcher.start();
  if (fixedWatcher) await fixedWatcher.start();

  consoleLogger.info('zettapay_listener.started', {
    merchant_id: merchantId,
    health_port: cfg.healthPort,
    storage: process.env.STORAGE ?? 'json',
    network: cfg.network,
    ws_url: cfg.wsUrl,
    base_enabled: Boolean(baseWatcher),
    base_rpc: baseWatcher ? baseWatcher.status().rpcUrl : undefined,
    fixed_address_enabled: Boolean(fixedWatcher),
    fixed_chains: fixedWatcher ? fixedWatcher.status().chains : undefined,
  });

  const shutdown = async (signal: string) => {
    consoleLogger.info('zettapay_listener.shutdown', { signal });
    try {
      await listener.stop();
      if (baseWatcher) await baseWatcher.stop();
      await dispatcher.stop();
      await apiServer.stop();
      if (storage.close) await storage.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

function topLevelHelp(version: string): string {
  return [
    `${c.bold('zettapay-listener')} ${c.dim('v' + version)} — self-hosted, non-custodial BTC payment watcher`,
    '',
    'Usage: zettapay-listener <command> [flags]',
    '',
    'Commands:',
    `  ${c.cyan('init')}             interactive setup wizard (.env + merchant.json)`,
    `  ${c.cyan('start')}            run watcher + webhook dispatcher (default)`,
    `  ${c.cyan('healthcheck')}      probe the local health server (exit 0/1)`,
    `  ${c.cyan('verify-config')}    validate .env without starting`,
    `  ${c.cyan('migrate')}          copy storage between adapters`,
    `  ${c.cyan('derive-address')}   derive a BIP-84 receive address (read-only)`,
    `  ${c.cyan('create-invoice')}   allocate next address + write invoice to storage`,
    '',
    'Run `zettapay-listener <command> --help` for command flags.',
    'Run `zettapay-listener --version` to print the installed version.',
    '',
  ].join('\n');
}

export async function dispatch(argv: readonly string[]): Promise<number> {
  await loadDotEnv(process.cwd());
  const [sub, ...rest] = argv;
  const version = packageVersion();

  // Top-level help / version BEFORE the start-default branch so
  // `zettapay-listener --help` doesn't fall into `run()` with empty env.
  if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(topLevelHelp(version));
    return 0;
  }
  if (sub === '--version' || sub === '-v' || sub === 'version') {
    process.stdout.write(`zettapay-listener ${version}\n`);
    return 0;
  }

  // No subcommand OR explicit `start`: boot the watcher. We default to `start`
  // so the existing Dockerfile CMD ["start"] / bare invocation both work.
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

  switch (sub) {
    case 'init':
      return await runInit(rest);
    case 'healthcheck':
      return await runHealthcheck(rest);
    case 'verify-config':
      return await runVerifyConfig(rest);
    case 'migrate':
      return await runMigrate(rest);
    case 'derive-address':
      return await runDeriveAddress(rest);
    case 'create-invoice':
      return await runCreateInvoice(rest);
    default:
      process.stderr.write(
        c.red(`unknown command "${sub}"`) +
          '\n\n' +
          topLevelHelp(version),
      );
      return 2;
  }
}

/**
 * Detect whether we were invoked as a CLI (vs imported as a module). The
 * `bin` shim installed by npm is a symlink in `<prefix>/bin/zettapay-listener`
 * pointing at `<install-dir>/dist/main.js`. Node resolves `process.argv[1]`
 * to the **symlink** path, NOT the target — so a `argv[1].endsWith('main.js')`
 * check alone misses every global install. We compare realpath(argv[1])
 * against the resolved path of this module, which is robust regardless of how
 * the CLI was invoked.
 */
function invokedAsScript(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const myFile = fileURLToPath(import.meta.url);
  if (argv1 === myFile) return true;
  try {
    if (realpathSync(argv1) === myFile) return true;
  } catch {
    /* argv[1] isn't a real path — fall through to suffix matches below. */
  }
  // Conservative suffix fallbacks for unusual invocations (esbuild bundles,
  // direct node invocations, Windows shims).
  return (
    argv1.endsWith(`${path.sep}main.js`) ||
    argv1.endsWith('/main.js') ||
    argv1.endsWith('\\main.js') ||
    argv1.endsWith(`${path.sep}zettapay-listener`) ||
    argv1.endsWith('/zettapay-listener') ||
    argv1.endsWith('\\zettapay-listener')
  );
}

if (invokedAsScript()) {
  dispatch(process.argv.slice(2)).then(
    (code) => {
      // Set the exit code but do NOT call process.exit(0) eagerly. Long-lived
      // subcommands (start) intentionally hold the event loop open via active
      // servers; short subcommands exit naturally once the loop drains. Only
      // force a hard exit on non-zero codes so error reporting flushes
      // synchronously.
      process.exitCode = code;
      if (code !== 0) process.exit(code);
    },
    (err) => {
      process.stderr.write(`zettapay-listener fatal: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
