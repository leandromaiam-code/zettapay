import { HttpError } from "./errors.js";

/**
 * EVM chains supported by ZettaPay payment endpoints. The shape mirrors the
 * Solana currency registry: a small canonical list with per-chain ERC-20
 * stablecoin contracts and env override hooks.
 */
export const SUPPORTED_EVM_CHAINS = [
  "base",
  "base-sepolia",
  "polygon",
  "polygon-amoy",
] as const;
export type EvmChain = (typeof SUPPORTED_EVM_CHAINS)[number];

export type EvmCurrency = "USDC";

export interface EvmChainDefinition {
  /** Canonical chain slug used in API requests. */
  id: EvmChain;
  /** Human-readable name. */
  name: string;
  /** EIP-155 chain ID. */
  chainId: number;
  /** Whether this chain is a testnet (mainnet gating uses this flag). */
  testnet: boolean;
  /** Env var that, when set, overrides the default public RPC URL. */
  rpcEnvKey: string;
  /** Default public RPC URL — fine for read-mostly testing, replace in prod. */
  defaultRpcUrl: string;
  /** ERC-20 stablecoin contracts available on this chain. */
  tokens: Record<EvmCurrency, EvmTokenDefinition>;
}

export interface EvmTokenDefinition {
  symbol: EvmCurrency;
  /** ERC-20 contract address (mixed case, EIP-55 checksum recommended). */
  address: `0x${string}`;
  /** ERC-20 `decimals()` — USDC is 6 across both Base and Polygon. */
  decimals: number;
  /** Env var override; takes precedence over the canonical address. */
  envOverrideKey: string;
}

// Canonical USDC ERC-20 addresses. Sources:
//   - Base mainnet:    Coinbase / Circle native USDC
//   - Base Sepolia:    Circle testnet USDC faucet
//   - Polygon mainnet: Circle native USDC (NOT the bridged USDC.e)
//   - Polygon Amoy:    Circle testnet USDC faucet
export const EVM_CHAIN_REGISTRY: Record<EvmChain, EvmChainDefinition> = {
  base: {
    id: "base",
    name: "Base",
    chainId: 8453,
    testnet: false,
    rpcEnvKey: "ZETTAPAY_BASE_RPC_URL",
    defaultRpcUrl: "https://mainnet.base.org",
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        decimals: 6,
        envOverrideKey: "ZETTAPAY_BASE_USDC",
      },
    },
  },
  "base-sepolia": {
    id: "base-sepolia",
    name: "Base Sepolia",
    chainId: 84532,
    testnet: true,
    rpcEnvKey: "ZETTAPAY_BASE_SEPOLIA_RPC_URL",
    defaultRpcUrl: "https://sepolia.base.org",
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        decimals: 6,
        envOverrideKey: "ZETTAPAY_BASE_SEPOLIA_USDC",
      },
    },
  },
  polygon: {
    id: "polygon",
    name: "Polygon",
    chainId: 137,
    testnet: false,
    rpcEnvKey: "ZETTAPAY_POLYGON_RPC_URL",
    defaultRpcUrl: "https://polygon-rpc.com",
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        decimals: 6,
        envOverrideKey: "ZETTAPAY_POLYGON_USDC",
      },
    },
  },
  "polygon-amoy": {
    id: "polygon-amoy",
    name: "Polygon Amoy",
    chainId: 80002,
    testnet: true,
    rpcEnvKey: "ZETTAPAY_POLYGON_AMOY_RPC_URL",
    defaultRpcUrl: "https://rpc-amoy.polygon.technology",
    tokens: {
      USDC: {
        symbol: "USDC",
        address: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
        decimals: 6,
        envOverrideKey: "ZETTAPAY_POLYGON_AMOY_USDC",
      },
    },
  },
};

export const DEFAULT_EVM_CURRENCY: EvmCurrency = "USDC";

export function isSupportedEvmChain(value: unknown): value is EvmChain {
  return (
    typeof value === "string" &&
    (SUPPORTED_EVM_CHAINS as readonly string[]).includes(value.toLowerCase())
  );
}

export function normalizeEvmChain(value: string | null | undefined): EvmChain {
  if (value === null || value === undefined || value === "") {
    throw HttpError.badRequest(
      `Field "chain" is required. Expected one of: ${SUPPORTED_EVM_CHAINS.join(", ")}`,
    );
  }
  const lower = value.toLowerCase();
  if (!(SUPPORTED_EVM_CHAINS as readonly string[]).includes(lower)) {
    throw HttpError.badRequest(
      `Unsupported EVM chain "${value}". Expected one of: ${SUPPORTED_EVM_CHAINS.join(", ")}`,
    );
  }
  return lower as EvmChain;
}

export interface ResolveEvmTokenOptions {
  chain: EvmChain;
  currency?: EvmCurrency;
  /** Per-chain explicit override map. */
  overrides?: Partial<Record<EvmChain, Partial<Record<EvmCurrency, string>>>>;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface ResolvedEvmToken {
  chain: EvmChain;
  currency: EvmCurrency;
  address: `0x${string}`;
  decimals: number;
}

export function resolveEvmToken(opts: ResolveEvmTokenOptions): ResolvedEvmToken {
  const currency = opts.currency ?? DEFAULT_EVM_CURRENCY;
  const def = EVM_CHAIN_REGISTRY[opts.chain];
  const token = def.tokens[currency];
  const override = opts.overrides?.[opts.chain]?.[currency];
  const fromEnv = (opts.env ?? process.env)[token.envOverrideKey];

  const candidate = override ?? fromEnv ?? token.address;
  if (!isHexAddress(candidate)) {
    throw HttpError.config(
      `${currency} address "${candidate}" for ${opts.chain} is not a valid 0x-prefixed 20-byte hex string.`,
    );
  }
  return {
    chain: opts.chain,
    currency,
    address: candidate as `0x${string}`,
    decimals: token.decimals,
  };
}

export function resolveRpcUrl(
  chain: EvmChain,
  env: Record<string, string | undefined> = process.env,
): string {
  const def = EVM_CHAIN_REGISTRY[chain];
  return env[def.rpcEnvKey]?.trim() || def.defaultRpcUrl;
}

const HEX_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function isHexAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && HEX_ADDRESS_RE.test(value);
}

/** Throws `HttpError.badRequest` if the address is not a 0x-prefixed 20-byte hex string. */
export function requireHexAddress(
  body: Record<string, unknown>,
  field: string,
): `0x${string}` {
  const value = body[field];
  if (typeof value !== "string" || !HEX_ADDRESS_RE.test(value)) {
    throw HttpError.badRequest(
      `Field "${field}" must be a valid 0x-prefixed Ethereum address`,
    );
  }
  return value as `0x${string}`;
}

export function optionalHexAddress(
  body: Record<string, unknown>,
  field: string,
): `0x${string}` | null {
  const value = body[field];
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !HEX_ADDRESS_RE.test(value)) {
    throw HttpError.badRequest(
      `Field "${field}" must be a valid 0x-prefixed Ethereum address when provided`,
    );
  }
  return value as `0x${string}`;
}
