import "dotenv/config";

export type SolanaCluster = "mainnet-beta" | "devnet" | "testnet" | "localnet";

const DEFAULT_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

export interface AppConfig {
  port: number;
  nodeEnv: string;
  solana: {
    cluster: SolanaCluster;
    rpcUrl: string;
    usdcMint: string;
    feePayerSecret: string | null;
    commitment: "processed" | "confirmed" | "finalized";
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
    default:
      return "devnet";
  }
}

export function loadConfig(): AppConfig {
  const cluster = parseCluster(process.env.SOLANA_CLUSTER);
  return {
    port: Number.parseInt(process.env.PORT ?? "3000", 10),
    nodeEnv: process.env.NODE_ENV ?? "development",
    solana: {
      cluster,
      rpcUrl: process.env.SOLANA_RPC_URL ?? DEFAULT_DEVNET_RPC,
      usdcMint: process.env.SOLANA_USDC_MINT ?? DEFAULT_USDC_DEVNET,
      feePayerSecret: process.env.SOLANA_FEE_PAYER_SECRET ?? null,
      commitment: (process.env.SOLANA_COMMITMENT as AppConfig["solana"]["commitment"]) ?? "confirmed",
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

export function resetConfigForTests(next?: AppConfig): void {
  cached = next ?? null;
}
