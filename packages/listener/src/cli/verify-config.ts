// `zettapay-listener verify-config` — validate .env without starting the
// listener. Used by CI / systemd ExecStartPre / human ops to catch typos
// before flipping a service into start. Exits 0 on full pass, 1 on failure.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  c,
  flagBool,
  flagString,
  parseFlags,
  readEnvFile,
  validateXpubFormat,
  XpubFormatError,
} from './util.js';

export interface VerifyOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

interface Check {
  label: string;
  ok: boolean;
  detail?: string;
}

function helpText(): string {
  return [
    `${c.bold('zettapay-listener verify-config')} — checklist of .env validity`,
    '',
    '  --env-file <path>  Override ./.env',
    '',
  ].join('\n');
}

export async function runVerifyConfig(
  argv: readonly string[],
  opts: VerifyOptions = {},
): Promise<number> {
  const { flags } = parseFlags(argv);
  if (flagBool(flags, 'help')) {
    process.stdout.write(helpText());
    return 0;
  }
  const cwd = opts.cwd ?? process.cwd();
  const envPath = flagString(flags, 'env-file') ?? path.join(cwd, '.env');
  const fileEnv = await readEnvFile(envPath);
  const env = { ...(fileEnv ?? {}), ...(opts.env ?? {}) };

  process.stdout.write(c.bold('verify-config') + ` (${envPath})\n\n`);

  const checks: Check[] = [];

  // .env exists
  checks.push(
    fileEnv == null
      ? {
          label: '.env present',
          ok: false,
          detail: `not found at ${envPath} — run \`zettapay-listener init\``,
        }
      : { label: '.env present', ok: true, detail: envPath },
  );

  // xpub format
  const xpub = env.MERCHANT_XPUB?.trim();
  if (!xpub) {
    checks.push({ label: 'MERCHANT_XPUB parseable', ok: false, detail: 'missing' });
  } else {
    try {
      const ck = validateXpubFormat(xpub);
      checks.push({
        label: 'MERCHANT_XPUB parseable',
        ok: true,
        detail: `${ck.prefix} (${ck.kind})`,
      });
    } catch (err) {
      const msg = err instanceof XpubFormatError ? err.message : String(err);
      checks.push({ label: 'MERCHANT_XPUB parseable', ok: false, detail: msg });
    }
  }

  // webhook URL is https
  const webhookUrl = env.MERCHANT_WEBHOOK_URL?.trim();
  if (!webhookUrl) {
    checks.push({ label: 'MERCHANT_WEBHOOK_URL is https://', ok: false, detail: 'missing' });
  } else {
    try {
      const u = new URL(webhookUrl);
      checks.push({
        label: 'MERCHANT_WEBHOOK_URL is https://',
        ok: u.protocol === 'https:',
        detail: u.protocol === 'https:' ? webhookUrl : `protocol=${u.protocol}`,
      });
    } catch {
      checks.push({
        label: 'MERCHANT_WEBHOOK_URL is https://',
        ok: false,
        detail: `cannot parse "${webhookUrl}"`,
      });
    }
  }

  // webhook secret present
  const secret = env.MERCHANT_WEBHOOK_SECRET?.trim();
  if (!secret) {
    checks.push({ label: 'MERCHANT_WEBHOOK_SECRET set', ok: false, detail: 'missing' });
  } else if (secret.length < 16) {
    checks.push({
      label: 'MERCHANT_WEBHOOK_SECRET set',
      ok: false,
      detail: `${secret.length} chars (need ≥16)`,
    });
  } else {
    checks.push({
      label: 'MERCHANT_WEBHOOK_SECRET set',
      ok: true,
      detail: `${secret.slice(0, 12)}…`,
    });
  }

  // health port valid
  const portRaw = env.HEALTH_PORT?.trim() ?? '8787';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    checks.push({ label: 'HEALTH_PORT valid', ok: false, detail: `"${portRaw}"` });
  } else {
    checks.push({ label: 'HEALTH_PORT valid', ok: true, detail: String(port) });
  }

  // storage reachable
  const storageKind = (env.STORAGE ?? 'json').toLowerCase();
  checks.push(await verifyStorage(storageKind, env));

  // Print checklist + summarize
  let failed = 0;
  for (const ck of checks) {
    const mark = ck.ok ? c.green('✓') : c.red('✗');
    const colorLabel = ck.ok ? ck.label : c.red(ck.label);
    process.stdout.write(`  ${mark} ${colorLabel}`);
    if (ck.detail) process.stdout.write(c.dim(`  (${ck.detail})`));
    process.stdout.write('\n');
    if (!ck.ok) failed += 1;
  }
  process.stdout.write('\n');
  if (failed === 0) {
    process.stdout.write(c.green(`all ${checks.length} checks passed`) + '\n');
    return 0;
  }
  process.stdout.write(c.red(`${failed} of ${checks.length} checks failed`) + '\n');
  return 1;
}

async function verifyStorage(
  kind: string,
  env: Record<string, string | undefined>,
): Promise<Check> {
  const label = `STORAGE=${kind} reachable`;
  switch (kind) {
    case 'json': {
      const dir = env.ZETTAPAY_DATA_DIR ?? defaultDataDir();
      try {
        await fs.access(dir);
        await fs.access(path.join(dir, 'merchant.json'));
        return { label, ok: true, detail: dir };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
        return { label, ok: false, detail: `${dir} — ${code}` };
      }
    }
    case 'sqlite': {
      const file =
        env.ZETTAPAY_SQLITE_FILE ?? path.join(env.ZETTAPAY_DATA_DIR ?? defaultDataDir(), 'zettapay.db');
      try {
        await fs.access(path.dirname(file));
        return { label, ok: true, detail: file };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'EUNKNOWN';
        return { label, ok: false, detail: `${file} — ${code}` };
      }
    }
    case 'supabase': {
      const url = env.SUPABASE_URL?.trim();
      const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
      if (!url || !key) {
        return {
          label,
          ok: false,
          detail: 'SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required',
        };
      }
      try {
        new URL(url);
        return { label, ok: true, detail: url };
      } catch {
        return { label, ok: false, detail: `bad SUPABASE_URL "${url}"` };
      }
    }
    case 'postgres': {
      const conn = env.POSTGRES_URL?.trim();
      if (!conn) return { label, ok: false, detail: 'POSTGRES_URL required' };
      return {
        label,
        ok: conn.startsWith('postgres://') || conn.startsWith('postgresql://'),
        detail: conn.replace(/:[^:@/]+@/, ':***@'),
      };
    }
    default:
      return { label, ok: false, detail: `unknown STORAGE="${kind}"` };
  }
}

function defaultDataDir(): string {
  return path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '.',
    '.zettapay',
    'data',
  );
}

export { helpText as verifyConfigHelp };
