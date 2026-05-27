// Tiny CLI helpers — argv flag parser + ANSI colors. Kept in-package
// (rather than depending on @zettapay/listener) because @zettapay/receiver
// is a standalone test tool and must be installable without dragging the
// listener tree along.

import { stdout } from 'node:process';

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
  cyan: (m: string) => paint('36', m),
};

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

export function flagInt(flags: FlagMap, name: string): number | undefined {
  const raw = flagString(flags, name);
  if (raw == null) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

export function flagBool(flags: FlagMap, name: string): boolean {
  return flags[name] === true || flags[name] === 'true';
}
