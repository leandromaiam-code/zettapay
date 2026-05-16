import { ConfigurationError } from "../lib/errors.js";

/**
 * Z22.1 — Beta launch protocol.
 *
 * Mainnet cutover gate: while `BETA_MODE_ENABLED=true`, the API only accepts
 * payments from a curated allowlist of merchants and enforces a per-merchant
 * cumulative spend cap covering the beta window. Disabling beta mode (the
 * default in dev/test) is a complete bypass — nothing here runs.
 */
export interface BetaLaunchConfig {
  enabled: boolean;
  /** Merchants permitted to transact while beta is active. Empty when disabled. */
  allowlist: ReadonlySet<string>;
  /** Cap on total non-failed payment volume per merchant during the beta window (USD). */
  merchantCapUsd: number;
  /** Hard ceiling on the allowlist size — prevents accidentally widening beta. */
  maxMerchants: number;
  /** ISO timestamp when the beta period started. Spend accrued before this is ignored. */
  launchAt: string | null;
  /** Beta duration in days. Spend windows close after launchAt + durationDays. */
  durationDays: number;
}

const DEFAULT_MERCHANT_CAP_USD = 10_000;
const DEFAULT_MAX_MERCHANTS = 10;
const DEFAULT_DURATION_DAYS = 30;

function readBoolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new ConfigurationError(`Invalid boolean env var ${name}=${raw}`);
}

function readNumber(
  name: string,
  fallback: number,
  options: { allowZero?: boolean } = {},
): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  const min = options.allowZero ? 0 : 1;
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new ConfigurationError(`Invalid numeric env var ${name}=${raw}`);
  }
  return parsed;
}

function readIsoOrNull(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) {
    throw new ConfigurationError(
      `Invalid ISO timestamp env var ${name}=${raw}`,
    );
  }
  return new Date(ts).toISOString();
}

function readCsv(name: string): string[] {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadBetaConfig(): BetaLaunchConfig {
  const enabled = readBoolean("BETA_MODE_ENABLED", false);
  // Z30.5 — cap=0 is the off-chain twin of on-chain `set_max_invoice_amount(0)`
  // = "no per-merchant ceiling". Negative values still rejected.
  const merchantCapUsd = readNumber(
    "BETA_MERCHANT_CAP_USDC",
    DEFAULT_MERCHANT_CAP_USD,
    { allowZero: true },
  );
  const maxMerchants = readNumber("BETA_MAX_MERCHANTS", DEFAULT_MAX_MERCHANTS);
  const durationDays = readNumber("BETA_DURATION_DAYS", DEFAULT_DURATION_DAYS);
  const launchAt = readIsoOrNull("BETA_LAUNCH_AT");
  const merchants = readCsv("BETA_ALLOWED_MERCHANTS");

  if (enabled && merchants.length > maxMerchants) {
    throw new ConfigurationError(
      `BETA_ALLOWED_MERCHANTS has ${merchants.length} entries, exceeds BETA_MAX_MERCHANTS=${maxMerchants}`,
    );
  }

  return {
    enabled,
    allowlist: new Set(merchants),
    merchantCapUsd,
    maxMerchants,
    launchAt,
    durationDays,
  };
}

/** ISO timestamp when the beta window closes (launchAt + durationDays), or null if never started. */
export function betaEndsAt(config: BetaLaunchConfig): string | null {
  if (!config.launchAt) return null;
  const start = Date.parse(config.launchAt);
  const end = start + config.durationDays * 24 * 60 * 60_000;
  return new Date(end).toISOString();
}

/** True when the beta window has passed (launchAt + durationDays in the past). */
export function isBetaExpired(config: BetaLaunchConfig, now: Date = new Date()): boolean {
  const ends = betaEndsAt(config);
  if (!ends) return false;
  return now.getTime() >= Date.parse(ends);
}
