import { HttpError } from "../lib/errors.js";
import type { Cluster, Currency } from "../lib/currencies.js";

/**
 * Cross-chain bridge source chains supported in Z11. USDC is routed natively
 * via Circle's CCTP (the same protocol that Wormhole Connect uses under the
 * hood for USDC), so each chain entry carries both its Wormhole chain id and
 * its CCTP domain — callers picking the underlying transport can use either.
 *
 * "destination" here is always Solana; only the source is parameterized.
 * Other stablecoins (USDT/EURC/PYUSD) require Wormhole TokenBridge wrapping
 * and are deliberately out of V1 scope — see ZettaPay premissas §I.2 / §V.16.
 */
export type SourceChain = "base" | "polygon";

export type Network = "mainnet" | "testnet";

export interface SourceChainConfig {
  chain: SourceChain;
  network: Network;
  /** EVM chain id (eth_chainId). */
  evmChainId: number;
  /** Wormhole chain id — see https://docs.wormhole.com/wormhole/reference/constants. */
  wormholeChainId: number;
  /** CCTP domain — see https://developers.circle.com/stablecoins/docs/supported-domains. */
  cctpDomain: number;
  /** Native USDC token contract on the source chain. */
  usdcTokenAddress: string;
  /** Circle TokenMessenger v1 (depositForBurn entry point). */
  tokenMessengerAddress: string;
  /** Circle MessageTransmitter v1 (where the source emits CCTP messages). */
  messageTransmitterAddress: string;
  /** Default JSON-RPC endpoint used in API responses for client convenience. */
  defaultRpcUrl: string;
}

export interface DestinationChainConfig {
  chain: "solana";
  network: Network;
  cluster: Cluster;
  /** Solana CCTP domain is fixed at 5 across mainnet/devnet. */
  cctpDomain: number;
  wormholeChainId: number;
  /** Solana CCTP MessageTransmitter program ID (mainnet & devnet share the address). */
  messageTransmitterProgramId: string;
  /** Solana CCTP TokenMessenger program ID (mainnet & devnet share the address). */
  tokenMessengerProgramId: string;
}

export const SOLANA_DESTINATIONS: Record<Network, DestinationChainConfig> = {
  mainnet: {
    chain: "solana",
    network: "mainnet",
    cluster: "mainnet-beta",
    cctpDomain: 5,
    wormholeChainId: 1,
    messageTransmitterProgramId:
      "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    tokenMessengerProgramId: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  },
  testnet: {
    chain: "solana",
    network: "testnet",
    cluster: "devnet",
    cctpDomain: 5,
    wormholeChainId: 1,
    messageTransmitterProgramId:
      "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd",
    tokenMessengerProgramId: "CCTPiPYPc6AsJuwueEnWgSgucamXDZwBd53dQ11YiKX3",
  },
};

export const SOURCE_CHAIN_REGISTRY: Record<
  SourceChain,
  Record<Network, SourceChainConfig>
> = {
  base: {
    mainnet: {
      chain: "base",
      network: "mainnet",
      evmChainId: 8453,
      wormholeChainId: 30,
      cctpDomain: 6,
      usdcTokenAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      tokenMessengerAddress: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962",
      messageTransmitterAddress: "0xAD09780d193884d503182aD4588450C416D6F9D4",
      defaultRpcUrl: "https://mainnet.base.org",
    },
    testnet: {
      chain: "base",
      network: "testnet",
      evmChainId: 84532,
      wormholeChainId: 10004,
      cctpDomain: 6,
      // USDC on Base Sepolia (Circle official testnet mint).
      usdcTokenAddress: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      tokenMessengerAddress: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      messageTransmitterAddress: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      defaultRpcUrl: "https://sepolia.base.org",
    },
  },
  polygon: {
    mainnet: {
      chain: "polygon",
      network: "mainnet",
      evmChainId: 137,
      wormholeChainId: 5,
      cctpDomain: 7,
      // Native USDC on Polygon PoS (Circle, not the bridged USDC.e).
      usdcTokenAddress: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      tokenMessengerAddress: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE",
      messageTransmitterAddress: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9",
      defaultRpcUrl: "https://polygon-rpc.com",
    },
    testnet: {
      chain: "polygon",
      network: "testnet",
      evmChainId: 80002,
      wormholeChainId: 10007,
      cctpDomain: 7,
      // USDC on Polygon Amoy (Circle official testnet mint).
      usdcTokenAddress: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      tokenMessengerAddress: "0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5",
      messageTransmitterAddress: "0x7865fAfC2db2093669d92c0F33AeEF291086BEFD",
      defaultRpcUrl: "https://rpc-amoy.polygon.technology",
    },
  },
};

export const SUPPORTED_SOURCE_CHAINS: readonly SourceChain[] = [
  "base",
  "polygon",
];

/**
 * USDC is the only currency bridged in V1 — wrapping non-USDC stablecoins
 * via Wormhole TokenBridge is intentionally deferred (premissa I.2).
 */
export const SUPPORTED_BRIDGE_CURRENCIES: readonly Currency[] = ["USDC"];

export function isSupportedSourceChain(value: unknown): value is SourceChain {
  return (
    typeof value === "string" &&
    (SUPPORTED_SOURCE_CHAINS as readonly string[]).includes(value.toLowerCase())
  );
}

export function normalizeSourceChain(value: string): SourceChain {
  const lower = value.toLowerCase();
  if (!(SUPPORTED_SOURCE_CHAINS as readonly string[]).includes(lower)) {
    throw HttpError.badRequest(
      `Unsupported source chain "${value}". Expected one of: ${SUPPORTED_SOURCE_CHAINS.join(", ")}`,
    );
  }
  return lower as SourceChain;
}

/**
 * Pick the network bucket (`mainnet` vs `testnet`) that matches the Solana
 * cluster the API is bound to. Bridging from Polygon-mainnet → Solana-devnet
 * is meaningless for CCTP (the burn never gets a Circle attestation against
 * a testnet domain), so we lock the two ends to the same network class.
 */
export function networkForCluster(cluster: Cluster): Network {
  switch (cluster) {
    case "mainnet-beta":
      return "mainnet";
    case "devnet":
    case "testnet":
    case "localnet":
      return "testnet";
  }
}

export function getSourceChainConfig(
  chain: SourceChain,
  network: Network,
): SourceChainConfig {
  const config = SOURCE_CHAIN_REGISTRY[chain][network];
  if (!config) {
    throw HttpError.config(
      `No bridge config for ${chain}/${network}. Add to SOURCE_CHAIN_REGISTRY.`,
    );
  }
  return config;
}

export function getDestinationConfig(network: Network): DestinationChainConfig {
  return SOLANA_DESTINATIONS[network];
}
