import { exit } from 'node:process';

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    console.error(`[zettapay-twitter] Missing required env var: ${name}`);
    exit(1);
  }
  return value.trim();
}

function optional(name: string, fallback = ''): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

function intOpt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function digest(raw: string): { weekday: number; hour: number } | null {
  if (!raw) return null;
  const [d, h] = raw.split(',').map((s) => s.trim());
  const wd = Number.parseInt(d ?? '', 10);
  const hr = Number.parseInt(h ?? '', 10);
  if (!Number.isFinite(wd) || wd < 0 || wd > 6) return null;
  if (!Number.isFinite(hr) || hr < 0 || hr > 23) return null;
  return { weekday: wd, hour: hr };
}

const dryRun = bool('DRY_RUN', true);

export const env = {
  dryRun,
  twitter: {
    apiKey: dryRun ? optional('TWITTER_API_KEY') : required('TWITTER_API_KEY'),
    apiSecret: dryRun
      ? optional('TWITTER_API_SECRET')
      : required('TWITTER_API_SECRET'),
    accessToken: dryRun
      ? optional('TWITTER_ACCESS_TOKEN')
      : required('TWITTER_ACCESS_TOKEN'),
    accessTokenSecret: dryRun
      ? optional('TWITTER_ACCESS_TOKEN_SECRET')
      : required('TWITTER_ACCESS_TOKEN_SECRET'),
  },
  apiBase: optional('ZETTAPAY_API_BASE', 'https://api.zettapay.io'),
  pollIntervalSeconds: intOpt('POLL_INTERVAL_SECONDS', 600),
  stateFile: optional('STATE_FILE', './state.json'),
  weeklyDigestAt: digest(optional('WEEKLY_DIGEST_AT', '1,15')),
  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
