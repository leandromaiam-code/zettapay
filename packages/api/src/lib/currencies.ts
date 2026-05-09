import { PublicKey } from "@solana/web3.js";
import { HttpError } from "./errors.js";

export const SUPPORTED_CURRENCIES = ["USDC", "USDT", "EURC", "PYUSD"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

export type Cluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

export interface CurrencyDefinition {
  symbol: Currency;
  decimals: number;
  mints: Partial<Record<Cluster, string>>;
  envOverrideKey: string;
}

// Canonical Solana SPL mints. Devnet entries are only filled where the
// issuer publishes a well-known address; the rest must be supplied via
// env overrides before they can be used on devnet/testnet/localnet.
export const CURRENCY_REGISTRY: Record<Currency, CurrencyDefinition> = {
  USDC: {
    symbol: "USDC",
    decimals: 6,
    mints: {
      "mainnet-beta": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    },
    envOverrideKey: "ZETTAPAY_USDC_MINT",
  },
  USDT: {
    symbol: "USDT",
    decimals: 6,
    mints: {
      "mainnet-beta": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
    envOverrideKey: "ZETTAPAY_USDT_MINT",
  },
  EURC: {
    symbol: "EURC",
    decimals: 6,
    mints: {
      "mainnet-beta": "HzwqbKZw8HxMN6bF2yFZNrht3c2iXXzpKcFu7uBEDKtr",
    },
    envOverrideKey: "ZETTAPAY_EURC_MINT",
  },
  PYUSD: {
    symbol: "PYUSD",
    decimals: 6,
    mints: {
      "mainnet-beta": "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo",
      devnet: "CXk2AMBfi3TwaEL2468s6zP8xq9NxTXjp9gjMgzeUynM",
    },
    envOverrideKey: "ZETTAPAY_PYUSD_MINT",
  },
};

export const DEFAULT_CURRENCY: Currency = "USDC";

export function isSupportedCurrency(value: unknown): value is Currency {
  return (
    typeof value === "string" &&
    (SUPPORTED_CURRENCIES as readonly string[]).includes(value.toUpperCase())
  );
}

export function normalizeCurrency(value: string | null | undefined): Currency {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_CURRENCY;
  }
  const upper = value.toUpperCase();
  if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(upper)) {
    throw HttpError.badRequest(
      `Unsupported currency "${value}". Expected one of: ${SUPPORTED_CURRENCIES.join(", ")}`,
    );
  }
  return upper as Currency;
}

export interface ResolveMintOptions {
  cluster: Cluster;
  /**
   * Optional explicit overrides indexed by currency symbol. A value here
   * trumps both the env override and the canonical registry entry — used
   * by `SolanaConfig` to honour the legacy `usdcMintAddress` field.
   */
  overrides?: Partial<Record<Currency, string>>;
  /**
   * Defaults to `process.env`. Tests can pass a frozen snapshot to keep
   * resolution deterministic.
   */
  env?: Record<string, string | undefined>;
}

export interface ResolvedMint {
  currency: Currency;
  decimals: number;
  mintAddress: string;
}

export function resolveMint(
  currency: Currency,
  opts: ResolveMintOptions,
): ResolvedMint {
  const def = CURRENCY_REGISTRY[currency];
  const override = opts.overrides?.[currency];
  const envKey = `${def.envOverrideKey}_${clusterEnvSuffix(opts.cluster)}`;
  const fromEnv = (opts.env ?? process.env)[envKey];
  const fromRegistry = def.mints[opts.cluster];

  const candidate = override ?? fromEnv ?? fromRegistry;
  if (!candidate) {
    throw HttpError.config(
      `No mint configured for ${currency} on ${opts.cluster}. Set ${envKey} or pass an explicit override.`,
    );
  }

  // Fail fast on malformed pubkeys — we'd hit the same error the first time
  // we tried to build a transfer instruction, but with a noisier stack.
  try {
    new PublicKey(candidate);
  } catch {
    throw HttpError.config(
      `Mint "${candidate}" for ${currency}/${opts.cluster} is not a valid base58 Solana public key.`,
    );
  }

  return { currency, decimals: def.decimals, mintAddress: candidate };
}

function clusterEnvSuffix(cluster: Cluster): string {
  switch (cluster) {
    case "mainnet-beta":
      return "MAINNET";
    case "devnet":
      return "DEVNET";
    case "testnet":
      return "TESTNET";
    case "localnet":
      return "LOCALNET";
  }
}
