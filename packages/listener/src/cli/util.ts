// Shared helpers for the `zettapay-listener` CLI. Intentionally dependency-free:
// readline prompts, ANSI colors, lightweight xpub format validation, and a
// canonical .env writer. None of this touches the network or persists anything
// beyond files the merchant explicitly requested.
//
// HR-CUSTODY: the xpub validator below REFUSES every SLIP-132 private prefix
// (xprv/yprv/zprv/tprv/uprv/vprv) plus BIP-39 mnemonics. Private material
// never gets logged or written.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const USE_COLOR = stdout.isTTY && process.env.NO_COLOR == null;

function paint(code: string, msg: string): string {
  return USE_COLOR ? `\x1b[${code}m${msg}\x1b[0m` : msg;
}

export const c = {
  bold: (m: string) => paint('1', m),
  dim: (m: string) => paint('2', m),
  red: (m: string) => paint('31', m),
  green: (m: string) => paint('32', m),
  yellow: (m: string) => paint('33', m),
  blue: (m: string) => paint('34', m),
  cyan: (m: string) => paint('36', m),
};

export function banner(): void {
  stdout.write(
    c.cyan('zettapay-listener') +
      ' ' +
      c.dim('— self-hosted, non-custodial BTC payment watcher') +
      '\n',
  );
}

export interface Prompter {
  ask(question: string, opts?: { default?: string; secret?: boolean }): Promise<string>;
  confirm(question: string, opts?: { default?: boolean }): Promise<boolean>;
  close(): void;
}

/**
 * Build a readline-backed Prompter. Tests inject their own implementation by
 * constructing the subcommand modules with a stub prompter.
 */
export function createPrompter(): Prompter {
  const rl = readline.createInterface({ input: stdin, output: stdout, terminal: stdout.isTTY });
  return {
    async ask(question, opts = {}) {
      const suffix = opts.default ? c.dim(` [${opts.default}]`) : '';
      const answer = (await rl.question(`${question}${suffix} `)).trim();
      if (answer === '' && opts.default !== undefined) return opts.default;
      return answer;
    },
    async confirm(question, opts = {}) {
      const def = opts.default ?? false;
      const hint = def ? 'Y/n' : 'y/N';
      const answer = (await rl.question(`${question} ${c.dim(`[${hint}]`)} `)).trim().toLowerCase();
      if (answer === '') return def;
      return answer === 'y' || answer === 'yes';
    },
    close() {
      rl.close();
      // readline.createInterface() calls stdin.resume() internally; close()
      // does NOT pause it, so without an explicit unref the event loop hangs
      // forever waiting for input that will never arrive. Manifests as
      // `init --force` printing "wrote .env" then never returning.
      try {
        stdin.unref();
      } catch {
        /* noop — some test harnesses replace stdin with a non-unref-able stream */
      }
    },
  };
}

// ---------- xpub validation (lightweight) ----------

const PRIVATE_PREFIXES = ['xprv', 'yprv', 'zprv', 'tprv', 'uprv', 'vprv'];
const PUBLIC_PREFIXES = ['xpub', 'ypub', 'zpub', 'tpub', 'upub', 'vpub'];
const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

export type XpubKind = 'mainnet' | 'testnet';

export interface XpubCheck {
  prefix: string;
  kind: XpubKind;
}

/**
 * Format-only xpub check used by `init` and `verify-config`. It refuses every
 * private-key prefix and the common mnemonic shape (>=12 lowercase words) so
 * the CLI never silently writes a signing key into .env.
 */
export function validateXpubFormat(raw: string): XpubCheck {
  const value = raw.trim();
  if (!value) throw new XpubFormatError('xpub is empty');
  if (/^([a-z]+(\s+[a-z]+){11,})$/i.test(value)) {
    throw new XpubFormatError(
      'looks like a BIP-39 mnemonic — refuse. ZettaPay only accepts the public xpub/zpub.',
    );
  }
  const prefix = value.slice(0, 4).toLowerCase();
  if (PRIVATE_PREFIXES.includes(prefix)) {
    throw new XpubFormatError(
      `extended PRIVATE key prefix "${prefix}" refused. Supply only the public xpub/zpub.`,
    );
  }
  if (!PUBLIC_PREFIXES.includes(prefix)) {
    throw new XpubFormatError(
      `unrecognized extended-key prefix "${prefix}". Expected one of: ${PUBLIC_PREFIXES.join(', ')}.`,
    );
  }
  if (value.length < 100 || value.length > 120) {
    throw new XpubFormatError(`xpub length ${value.length} out of bounds (100..120)`);
  }
  if (!BASE58_CHARS.test(value)) {
    throw new XpubFormatError('xpub contains characters outside the base58 alphabet');
  }
  const kind: XpubKind = prefix.startsWith('t') || prefix.startsWith('u') || prefix.startsWith('v')
    ? 'testnet'
    : 'mainnet';
  return { prefix, kind };
}

export class XpubFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XpubFormatError';
  }
}

// ---------- secret generation ----------

/**
 * Generate a Stripe-style webhook secret: `whsec_` + 32 random bytes encoded
 * as url-safe base64. Shown to the merchant ONCE; we persist only its sha256
 * in storage (the dispatcher signs with the raw secret from the env).
 */
export function generateWebhookSecret(): string {
  const raw = randomBytes(32).toString('base64url');
  return `whsec_${raw}`;
}

// ---------- .env serializer ----------

export interface EnvFile {
  [key: string]: string;
}

export function serializeEnv(values: EnvFile): string {
  const lines: string[] = [
    '# @zettapay/listener configuration — generated by `zettapay-listener init`',
    '# Edit by hand if you must, but keep the keys above intact.',
    '',
  ];
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === '') continue;
    lines.push(`${key}=${quoteIfNeeded(value)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  if (/^[A-Za-z0-9_\-./:@+=,]+$/.test(value)) return value;
  return JSON.stringify(value);
}

/**
 * Minimal .env parser: supports `KEY=VALUE` with optional double-quoted
 * values. Comments + blank lines ignored. Does NOT evaluate ${VAR}
 * interpolation — by design.
 */
export function parseEnv(raw: string): EnvFile {
  const out: EnvFile = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        /* keep raw */
      }
    }
    out[key] = value;
  }
  return out;
}

export async function readEnvFile(file: string): Promise<EnvFile | null> {
  try {
    return parseEnv(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write .env with mode 0600 so a stray world-readable umask doesn't leak the
 * webhook secret. Caller is expected to confirm overwrite.
 */
export async function writeEnvFile(file: string, values: EnvFile): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeEnv(values), { encoding: 'utf8', mode: 0o600 });
}

// ---------- argv helpers ----------

export type FlagMap = Record<string, string | true>;

export function parseFlags(argv: readonly string[]): { positional: string[]; flags: FlagMap } {
  const flags: FlagMap = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i] as string;
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next != null && !next.startsWith('--')) {
          flags[tok.slice(2)] = next;
          i += 1;
        } else {
          flags[tok.slice(2)] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { positional, flags };
}

export function flagString(flags: FlagMap, name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

export function flagBool(flags: FlagMap, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
