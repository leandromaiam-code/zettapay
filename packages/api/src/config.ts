import "dotenv/config";
import { clusterApiUrl, type Commitment } from "@solana/web3.js";

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

const DEFAULT_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const ALLOWED_COMMITMENTS: ReadonlyArray<Commitment> = [
  "processed",
  "confirmed",
  "finalized",
];

export interface AppConfig {
  port: number;
  nodeEnv: string;
  solana: {
    cluster: SolanaCluster;
    rpcUrl: string;
    usdcMint: string;
    feePayerSecret: string | null;
    commitment: Commitment;
  };
  binding: {
    memoNamespace: string;
  };
}

function parseCluster(raw: string | undefined): SolanaCluster {
  switch ((raw ?? "devnet").toLowerCase()) {
    case "mainnet-beta":
    case "mainnet":
      return "mainnet-beta";
    case "testnet":
      return "testnet";
    case "localnet":
    case "localhost":
      return "localnet";
    case "devnet":
      return "devnet";
    default:
      throw new Error(
        `Invalid SOLANA_NETWORK="${raw}". Expected one of: mainnet-beta, mainnet, devnet, testnet, localnet.`,
      );
  }
}

function parseCommitment(raw: string | undefined): Commitment {
  if (raw === undefined || raw === "") return "confirmed";
  if (ALLOWED_COMMITMENTS.includes(raw as Commitment)) return raw as Commitment;
  throw new Error(
    `Invalid SOLANA_COMMITMENT="${raw}". Expected one of: ${ALLOWED_COMMITMENTS.join(", ")}.`,
  );
}

function defaultRpcUrl(cluster: SolanaCluster): string {
  if (cluster === "localnet") return "http://127.0.0.1:8899";
  return clusterApiUrl(cluster);
}

function defaultUsdcMint(cluster: SolanaCluster): string {
  return cluster === "mainnet-beta" ? DEFAULT_USDC_MAINNET : DEFAULT_USDC_DEVNET;
}

export function loadConfig(): AppConfig {
  // SOLANA_NETWORK is the canonical key; legacy SOLANA_CLUSTER read as a fallback
  // so deployments mid-migration don't lose their cluster pin.
  const rawNetwork = process.env.SOLANA_NETWORK ?? process.env.SOLANA_CLUSTER;
  const cluster = parseCluster(rawNetwork);
  return {
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    solana: {
      cluster,
      rpcUrl: process.env.SOLANA_RPC_URL ?? defaultRpcUrl(cluster),
      usdcMint: process.env.SOLANA_USDC_MINT ?? defaultUsdcMint(cluster),
      feePayerSecret: process.env.SOLANA_FEE_PAYER_SECRET ?? null,
      commitment: parseCommitment(process.env.SOLANA_COMMITMENT),
    },
    binding: {
      memoNamespace: process.env.ZETTAPAY_MEMO_NAMESPACE ?? "zettapay:merchant_register:v1",
    },
  };
}

let cached: AppConfig | null = null;
export function getConfig(): AppConfig {
  if (cached === null) cached = loadConfig();
  return cached;
}

export function getCluster(): SolanaCluster {
  return getConfig().solana.cluster;
}

export function isMainnet(): boolean {
  return getCluster() === "mainnet-beta";
}

export function resetConfigForTests(next?: AppConfig): void {
  cached = next ?? null;
}
