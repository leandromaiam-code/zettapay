// `zettapay-listener init` — interactive bootstrap. Generates a .env in the
// merchant's cwd and, when STORAGE=json, seeds ~/.zettapay/data/merchant.json
// (or whatever ZETTAPAY_DATA_DIR points at). No network calls.
//
// Flags (all optional — anything missing is asked at the prompt):
//   --xpub <zpub>       BIP-84 account-level public key
//   --shop-name <s>
//   --email <s>
//   --webhook-url <url>
//   --storage <json|sqlite|supabase|postgres>
//   --data-dir <path>   STORAGE=json/sqlite only; overrides ~/.zettapay/data
//   --supabase-url <url>      STORAGE=supabase
//   --supabase-key <key>      STORAGE=supabase service-role key
//   --postgres-url <conn>     STORAGE=postgres connection string
//   --health-port <n>
//   --force             Overwrite an existing .env without confirmation

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  banner,
  c,
  classifyWebhookUrl,
  createPrompter,
  flagBool,
  flagString,
  generateWebhookSecret,
  isAllowedWebhookUrl,
  parseFlags,
  readEnvFile,
  validateXpubFormat,
  writeEnvFile,
  XpubFormatError,
  type Prompter,
  type EnvFile,
} from './util.js';
import {
  ALL_NETWORKS,
  defaultNetworkForXpubKind,
  isNetwork,
  isNetworkCompatibleWithXpub,
  type Network,
} from '../network.js';

export interface InitOptions {
  cwd?: string;
  prompter?: Prompter;
  env?: NodeJS.ProcessEnv;
}

const STORAGE_KINDS = ['json', 'sqlite', 'supabase', 'postgres'] as const;
type StorageKind = (typeof STORAGE_KINDS)[number];

function helpText(): string {
  return [
    `${c.bold('zettapay-listener init')} — bootstrap merchant config + .env`,
    '',
    'Interactive wizard. Pass any of the following flags to skip prompts:',
    '  --xpub <zpub>           Account-level BIP-84 public key',
    '  --network <n>           mainnet | testnet | signet | regtest (defaults to xpub kind)',
    '  --shop-name <name>',
    '  --email <addr>',
    '  --webhook-url <url>     HTTPS URL on your backend',
    '  --storage <kind>        json | sqlite | supabase | postgres',
    '  --data-dir <path>       Override ~/.zettapay/data (json/sqlite only)',
    '  --supabase-url <url>    Required when --storage=supabase',
    '  --supabase-key <key>    Service-role key (supabase)',
    '  --postgres-url <conn>   Required when --storage=postgres',
    '  --health-port <n>       Override 8787',
    '  --force                 Overwrite an existing .env without confirmation',
    '',
    `${c.yellow('HR-CUSTODY:')} init refuses any extended PRIVATE key (xprv/zprv/...).`,
    '',
  ].join('\n');
}

export async function runInit(
  argv: readonly string[],
  opts: InitOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help') || flags['h'] === true) {
    process.stdout.write(helpText());
    return 0;
  }

  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const envPath = path.join(cwd, '.env');

  banner();
  process.stdout.write(c.bold('init') + ' — answer the prompts (or pass flags to skip)\n\n');

  const existing = await readEnvFile(envPath);
  if (existing && !flagBool(flags, 'force')) {
    const p = opts.prompter ?? createPrompter();
    try {
      const overwrite = await p.confirm(
        `${envPath} already exists. Overwrite?`,
        { default: false },
      );
      if (!overwrite) {
        process.stdout.write(c.yellow('aborted — leaving existing .env untouched\n'));
        return 1;
      }
    } finally {
      if (!opts.prompter) p.close();
    }
  }

  const prompter = opts.prompter ?? createPrompter();
  try {
    // ----- (a) xpub -----
    let xpubInput = flagString(flags, 'xpub');
    let xpubKind: 'mainnet' | 'testnet';
    while (true) {
      if (!xpubInput) {
        xpubInput = await prompter.ask(
          `${c.bold('xpub')} (BIP-84 zpub for mainnet, or vpub for testnet/signet):`,
        );
      }
      try {
        const check = validateXpubFormat(xpubInput);
        xpubKind = check.kind;
        process.stdout.write(
          c.green(`  ✓ accepted ${check.prefix} (${check.kind})`) + '\n',
        );
        break;
      } catch (err) {
        const msg = err instanceof XpubFormatError ? err.message : String(err);
        process.stdout.write(c.red(`  ✗ ${msg}`) + '\n');
        if (flagString(flags, 'xpub')) {
          // Non-interactive — fail fast instead of looping.
          return 2;
        }
        xpubInput = undefined;
      }
    }

    // ----- (a.5) network -----
    // Default: derive from xpub kind. A mainnet xpub locks to mainnet; a
    // testnet-family xpub can target testnet|signet|regtest. We persist the
    // selected Network (not just kind) so `verify-config` + the listener
    // boot path can pick the right mempool.space cluster without re-asking.
    let network: Network;
    const networkFlag = flagString(flags, 'network');
    if (networkFlag) {
      if (!isNetwork(networkFlag)) {
        process.stdout.write(
          c.red(`  ✗ unknown --network "${networkFlag}". Expected one of: ${ALL_NETWORKS.join(', ')}`) + '\n',
        );
        return 2;
      }
      if (!isNetworkCompatibleWithXpub(networkFlag, xpubKind)) {
        process.stdout.write(
          c.red(
            `  ✗ --network ${networkFlag} is incompatible with a ${xpubKind} xpub. ` +
              (xpubKind === 'mainnet'
                ? 'mainnet xpub only watches mainnet.'
                : 'testnet xpub watches testnet|signet|regtest.'),
          ) + '\n',
        );
        return 2;
      }
      network = networkFlag;
    } else if (xpubKind === 'mainnet') {
      network = 'mainnet';
    } else {
      // Interactive prompt — signet default keeps "test before mainnet" cheap.
      while (true) {
        const reply = await prompter.ask(
          `${c.bold('network')} (testnet|signet|regtest):`,
          { default: 'signet' },
        );
        const cand = reply.toLowerCase();
        if (isNetwork(cand) && isNetworkCompatibleWithXpub(cand, xpubKind)) {
          network = cand;
          break;
        }
        process.stdout.write(c.red(`  ✗ "${reply}" is not a testnet-family network`) + '\n');
      }
    }
    process.stdout.write(c.green(`  ✓ network=${network}`) + '\n');

    // ----- (b) storage backend -----
    let storage = flagString(flags, 'storage') as StorageKind | undefined;
    while (!storage || !STORAGE_KINDS.includes(storage)) {
      const reply = await prompter.ask(
        `${c.bold('STORAGE backend')} (json|sqlite|supabase|postgres):`,
        { default: 'json' },
      );
      const cand = reply.toLowerCase() as StorageKind;
      if (STORAGE_KINDS.includes(cand)) {
        storage = cand;
      } else {
        process.stdout.write(c.red(`  ✗ unknown storage "${reply}"`) + '\n');
        if (flagString(flags, 'storage')) return 2;
      }
    }

    // ----- (c) supabase / postgres extras -----
    let supabaseUrl: string | undefined;
    let supabaseKey: string | undefined;
    let postgresUrl: string | undefined;
    if (storage === 'supabase') {
      supabaseUrl = flagString(flags, 'supabase-url') ||
        (await prompter.ask(c.bold('SUPABASE_URL:')));
      supabaseKey = flagString(flags, 'supabase-key') ||
        (await prompter.ask(c.bold('SUPABASE_SERVICE_ROLE_KEY:'), { secret: true }));
    } else if (storage === 'postgres') {
      postgresUrl = flagString(flags, 'postgres-url') ||
        (await prompter.ask(c.bold('POSTGRES_URL:'), { secret: true }));
    }

    // ----- shop name + email -----
    const shopName = flagString(flags, 'shop-name') ||
      (await prompter.ask(c.bold('Shop name:')));
    const email = flagString(flags, 'email') ||
      (await prompter.ask(c.bold('Operator email:')));

    // ----- (d) webhook URL -----
    // Policy lives in classifyWebhookUrl: https everywhere, plus a documented
    // localhost-http carve-out for @zettapay/receiver running on the merchant's
    // laptop/CI. Mirrors the dispatcher guard so init never rejects a URL the
    // running daemon would happily POST to (Z65 contract).
    let webhookUrl = flagString(flags, 'webhook-url');
    while (!webhookUrl || !isAllowedWebhookUrl(webhookUrl)) {
      if (webhookUrl) {
        const policy = classifyWebhookUrl(webhookUrl);
        const reason = policy.ok ? '' : policy.reason;
        process.stdout.write(
          c.red(
            `  ✗ webhook URL must be https:// (or http://localhost for dev). ` +
              `got "${webhookUrl}" — ${reason}`,
          ) + '\n',
        );
        if (flagString(flags, 'webhook-url')) return 2;
      }
      webhookUrl = await prompter.ask(
        c.bold('MERCHANT_WEBHOOK_URL (https://yourapi/zettapay/hook):'),
      );
    }
    const webhookPolicy = classifyWebhookUrl(webhookUrl);
    if (webhookPolicy.ok && webhookPolicy.mode === 'localhost-http') {
      process.stdout.write(c.yellow(`  ⚠ ${webhookPolicy.warning}`) + '\n');
    }

    // ----- (e) webhook secret -----
    const webhookSecret = generateWebhookSecret();

    // ----- data-dir / health-port -----
    const dataDir = flagString(flags, 'data-dir') ||
      env.ZETTAPAY_DATA_DIR ||
      path.join(os.homedir(), '.zettapay', 'data');
    const healthPort = flagString(flags, 'health-port') || '8787';

    // ----- write merchant.json (json backend) -----
    let merchantId: string | undefined;
    if (storage === 'json') {
      merchantId = await seedJsonMerchant({
        dataDir,
        shopName,
        email,
        xpub: xpubInput as string,
        webhookUrl,
        webhookSecret,
      });
      process.stdout.write(
        c.green(`  ✓ seeded ${path.join(dataDir, 'merchant.json')}`) + '\n',
      );
    }

    // ----- write .env -----
    const envValues: EnvFile = {
      STORAGE: storage,
      ZETTAPAY_DATA_DIR: dataDir,
      MERCHANT_WEBHOOK_URL: webhookUrl,
      MERCHANT_WEBHOOK_SECRET: webhookSecret,
      MERCHANT_SHOP_NAME: shopName,
      MERCHANT_EMAIL: email,
      MERCHANT_XPUB: xpubInput as string,
      MERCHANT_NETWORK: network,
      HEALTH_PORT: healthPort,
    };
    if (merchantId) envValues.MERCHANT_ID = merchantId;
    if (supabaseUrl) envValues.SUPABASE_URL = supabaseUrl;
    if (supabaseKey) envValues.SUPABASE_SERVICE_ROLE_KEY = supabaseKey;
    if (postgresUrl) envValues.POSTGRES_URL = postgresUrl;

    await writeEnvFile(envPath, envValues);

    process.stdout.write('\n' + c.green(`  ✓ wrote ${envPath} (mode 0600)`) + '\n');
    process.stdout.write('\n' + c.bold('webhook signing secret (shown once):') + '\n');
    process.stdout.write('  ' + c.cyan(webhookSecret) + '\n');
    process.stdout.write(
      c.dim('  Copy this into your backend now. ZettaPay does not store the raw value.') +
        '\n\n',
    );
    process.stdout.write(
      c.dim('Next steps:') +
        '\n  1) ' +
        c.cyan('zettapay-listener verify-config') +
        '\n  2) ' +
        c.cyan('zettapay-listener start') +
        '\n',
    );
    return 0;
  } finally {
    if (!opts.prompter) prompter.close();
  }
}

interface SeedArgs {
  dataDir: string;
  shopName: string;
  email: string;
  xpub: string;
  webhookUrl: string;
  webhookSecret: string;
}

async function seedJsonMerchant(args: SeedArgs): Promise<string> {
  await fs.mkdir(args.dataDir, { recursive: true });
  await fs.mkdir(path.join(args.dataDir, 'invoices'), { recursive: true });
  await fs.mkdir(path.join(args.dataDir, 'webhook_events'), { recursive: true });
  const merchantPath = path.join(args.dataDir, 'merchant.json');
  // Idempotent: keep existing merchant if present
  try {
    const raw = await fs.readFile(merchantPath, 'utf8');
    const existing = JSON.parse(raw) as { id?: string };
    if (existing?.id) return existing.id;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const id = generateMerchantId();
  const merchant = {
    id,
    shop_name: args.shopName,
    email: args.email,
    xpub: args.xpub,
    webhook_url: args.webhookUrl,
    webhook_secret_hash: createHash('sha256').update(args.webhookSecret).digest('hex'),
    next_child_index: 0,
    created_at: new Date().toISOString(),
  };
  await fs.writeFile(merchantPath, JSON.stringify(merchant, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  return id;
}

function generateMerchantId(): string {
  return randomUUID();
}

export { helpText as initHelp };
