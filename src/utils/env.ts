import 'dotenv/config';

type Cluster = 'devnet' | 'testnet' | 'mainnet-beta';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseCluster(value: string): Cluster {
  if (value === 'devnet' || value === 'testnet' || value === 'mainnet-beta') {
    return value;
  }
  throw new Error(`Invalid SOLANA_CLUSTER: ${value}`);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: Number.parseInt(process.env.PORT ?? '3000', 10),
  solanaCluster: parseCluster(required('SOLANA_CLUSTER', 'devnet')),
  solanaRpcUrl: required('SOLANA_RPC_URL', 'https://api.devnet.solana.com'),
  usdcMint: required('USDC_MINT', '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'),
} as const;

export type Env = typeof env;
