const DEFAULT_DEVNET_RPC = "https://api.devnet.solana.com";

const NETWORKS = ["devnet", "testnet", "mainnet-beta"] as const;
export type SolanaNetwork = (typeof NETWORKS)[number];

function parseNetwork(raw: string | undefined): SolanaNetwork {
  if (!raw) return "devnet";
  if ((NETWORKS as readonly string[]).includes(raw)) return raw as SolanaNetwork;
  throw new Error(
    `Invalid SOLANA_NETWORK="${raw}". Expected one of: ${NETWORKS.join(", ")}.`,
  );
}

function parseInteger(name: string, raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid ${name}="${raw}". Expected a non-negative integer.`);
  }
  return n;
}

export interface AppEnv {
  port: number;
  solanaNetwork: SolanaNetwork;
  solanaRpcUrl: string;
  rpcMaxRetries: number;
  rpcInitialBackoffMs: number;
  rpcMaxBackoffMs: number;
  faucetMaxAirdropLamports: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const network = parseNetwork(source.SOLANA_NETWORK);
  const rpcUrl = source.SOLANA_RPC_URL?.trim() || DEFAULT_DEVNET_RPC;
  return {
    port: parseInteger("PORT", source.PORT, 3001),
    solanaNetwork: network,
    solanaRpcUrl: rpcUrl,
    rpcMaxRetries: parseInteger("RPC_MAX_RETRIES", source.RPC_MAX_RETRIES, 5),
    rpcInitialBackoffMs: parseInteger(
      "RPC_INITIAL_BACKOFF_MS",
      source.RPC_INITIAL_BACKOFF_MS,
      250,
    ),
    rpcMaxBackoffMs: parseInteger("RPC_MAX_BACKOFF_MS", source.RPC_MAX_BACKOFF_MS, 4000),
    faucetMaxAirdropLamports: parseInteger(
      "FAUCET_MAX_AIRDROP_LAMPORTS",
      source.FAUCET_MAX_AIRDROP_LAMPORTS,
      2_000_000_000,
    ),
  };
}
